import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  IBookmark,
  IBookmarkGroup,
  IBookmarkStorageSchema
} from '../types.js';


/*
 * 《核心位置》：书签数据持久化与外部同步管理器 (全面支持多工作区 Multi-root Workspace)
 * 逻辑解释：
 * 1. 存储定位：优先以 .code-workspace 配置文件所在目录为准；若为普通文件夹，则以根目录为准。
 * 2. 路径处理：基于 vscode.workspace.asRelativePath(uri, true) 统一规范化，多根工作区自动带上子项目名前缀，绝不产生 ../ 相对路径。
 * 3. 具备内部写锁与 300ms 防抖，杜绝自身写入触发 FileSystemWatcher 造成的死循环与界面抖动。
 * 隐患点：在无工作区（未打开文件夹或无保存工作区文件）的空窗口下需防御性退出，避免 path.join 报错。
 */
export class StorageManager implements vscode.Disposable {
  private _onDidChangeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeData = this._onDidChangeData.event;

  private schema: IBookmarkStorageSchema = {
    version: 1,
    defaultGroupId: DEFAULT_GROUP_ID,
    groups: [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }],
    bookmarks: []
  };

  private fileWatcher?: vscode.FileSystemWatcher;
  private isInternalWriting = false;
  private saveTimeout?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private currentStorageLocation: 'vscode' | 'root' = 'vscode';
  private isSwitchingLocation = false;

  constructor() {
    const config = vscode.workspace.getConfiguration('xmark');
    this.currentStorageLocation = config.get<'vscode' | 'root'>('storageLocation', 'vscode');
    this.initWatcher();
    this.loadFromDisk();

    // 监听设置变更 (如 storageLocation 改变) 与工作区目录变动
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('xmark.storageLocation')) {
          await this.handleStorageLocationChange();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.initWatcher();
        this.loadFromDisk();
      })
    );
  }

  /**
   * 《核心位置》：多根工作区与单目录存储路径智能推导
   * 逻辑解释：
   * 1. 优先检测 vscode.workspace.workspaceFile (即 .code-workspace 配置文件)。
   *    若存在且为 file 协议，直接使用该配置文件所在的父级目录作为根基准。
   * 2. 若不存在工作区配置文件，则平滑降级使用 workspaceFolders[0] 根目录。
   * 3. 按指定 location 构建目标文件 Uri。
   * 隐患点：空工作区（未打开任何目录）将返回 undefined，调用方需做保护。
   */
  public getStorageUriForLocation(location: 'vscode' | 'root'): vscode.Uri | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    let rootUri: vscode.Uri | undefined;

    if (workspaceFile && workspaceFile.scheme === 'file') {
      rootUri = vscode.Uri.file(path.dirname(workspaceFile.fsPath));
    } else {
      rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    if (!rootUri) {
      return undefined;
    }

    if (location === 'root') {
      return vscode.Uri.joinPath(rootUri, 'bookmark.json');
    }
    return vscode.Uri.joinPath(rootUri, '.vscode', 'bookmark.json');
  }

  public getStorageUri(): vscode.Uri | undefined {
    return this.getStorageUriForLocation(this.currentStorageLocation);
  }

  /**
   * 《核心位置》：存储位置动态切换、自动迁移与冲突决策
   * 逻辑解释：
   * 1. 状态防重：如果当前正在切换流程中，或者配置项值与当前内存所记录的 location 一致，则无需重复执行。
   * 2. 防抖落盘：若有处于防抖阶段的未写磁盘数据，先立即落盘至旧位置，确保数据一致。
   * 3. 目标无文件迁移：若新位置尚无 bookmark.json，则将当前书签数据安全写入新位置，并销毁旧 Watcher 后清理旧文件（保持全工程单一真实源），避免残留脏数据。
   * 4. 冲突判定与决策弹窗：若新旧两处均存在文件，弹出 WarningMessage 供用户选择：载入新位置现有文件、用当前书签覆盖新位置、或取消切换并回退配置。
   * 隐患点：在没有读写权限的工作区路径下，fs.unlink / fs.writeFile 可能抛错，需完善 try-catch 保护并输出日志。
   */
  private async handleStorageLocationChange(): Promise<void> {
    if (this.isSwitchingLocation) {
      return;
    }

    const config = vscode.workspace.getConfiguration('xmark');
    const newLocation = config.get<'vscode' | 'root'>('storageLocation', 'vscode');
    if (newLocation === this.currentStorageLocation) {
      return;
    }

    // 若有正在防抖倒计时的落盘任务，先强制落盘至旧位置
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = undefined;
      await this.flushToDisk();
    }

    const oldLocation = this.currentStorageLocation;
    const oldUri = this.getStorageUriForLocation(oldLocation);
    const newUri = this.getStorageUriForLocation(newLocation);

    if (!oldUri || !newUri) {
      this.currentStorageLocation = newLocation;
      this.initWatcher();
      await this.loadFromDisk();
      return;
    }

    const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
      try {
        await fs.access(uri.fsPath);
        return true;
      } catch {
        return false;
      }
    };

    const oldExists = await fileExists(oldUri);
    const newExists = await fileExists(newUri);

    // 场景 1：目标新位置不存在 bookmark.json（自动迁移旧数据并清理旧文件）
    if (!newExists) {
      if (oldExists) {
        try {
          // 先销毁旧监听器，防止删除旧文件时触发 onDidDelete 清空内存书签
          this.fileWatcher?.dispose();
          this.fileWatcher = undefined;

          await fs.mkdir(path.dirname(newUri.fsPath), { recursive: true });
          const content = JSON.stringify(this.schema, null, 2);
          await fs.writeFile(newUri.fsPath, content, 'utf-8');
          await fs.unlink(oldUri.fsPath);
        } catch (err) {
          console.error('[XMark] 迁移存储文件至新位置失败:', err);
        }

        const targetName = newLocation === 'root'
          ? vscode.l10n.t('root directory')
          : vscode.l10n.t('.vscode directory');
        vscode.window.showInformationMessage(
          vscode.l10n.t('Bookmark storage migrated to {0} and old file cleaned up', targetName)
        );
      }

      this.currentStorageLocation = newLocation;
      this.initWatcher();
      await this.loadFromDisk();
      return;
    }

    // 场景 2：新位置已存在，且旧位置不存在（自然切换加载）
    if (!oldExists) {
      this.currentStorageLocation = newLocation;
      this.initWatcher();
      await this.loadFromDisk();
      return;
    }

    // 场景 3：新旧两处均存在文件（冲突判定，弹窗由用户决策）
    const OPTION_LOAD_NEW = vscode.l10n.t('Load Existing from New Location');
    const OPTION_OVERWRITE_NEW = vscode.l10n.t('Overwrite New Location with Current Bookmarks');
    const OPTION_CANCEL = vscode.l10n.t('Cancel Switch');

    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Both old and new locations have a bookmark.json file. How would you like to proceed?'),
      OPTION_LOAD_NEW,
      OPTION_OVERWRITE_NEW,
      OPTION_CANCEL
    );

    if (choice === OPTION_LOAD_NEW) {
      this.currentStorageLocation = newLocation;
      this.initWatcher();
      await this.loadFromDisk();

      const CLEAN_OLD = vscode.l10n.t('Clean Up Old File');
      const KEEP_OLD = vscode.l10n.t('Keep Old File');
      const cleanChoice = await vscode.window.showInformationMessage(
        vscode.l10n.t('Switched to new location bookmarks. Delete old bookmark.json file?'),
        CLEAN_OLD,
        KEEP_OLD
      );
      if (cleanChoice === CLEAN_OLD) {
        try {
          await fs.unlink(oldUri.fsPath);
        } catch (err) {
          console.warn('[XMark] 删除旧存储文件失败:', err);
        }
      }
    } else if (choice === OPTION_OVERWRITE_NEW) {
      try {
        // 先销毁旧监听器，防止删除旧文件时触发 onDidDelete
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;

        await fs.mkdir(path.dirname(newUri.fsPath), { recursive: true });
        const content = JSON.stringify(this.schema, null, 2);
        await fs.writeFile(newUri.fsPath, content, 'utf-8');
        await fs.unlink(oldUri.fsPath);
      } catch (err) {
        console.error('[XMark] 覆盖新位置或清理旧文件失败:', err);
      }

      this.currentStorageLocation = newLocation;
      this.initWatcher();
      await this.loadFromDisk();

      vscode.window.showInformationMessage(
        vscode.l10n.t('New location overwritten with current bookmarks and old file cleaned up')
      );
    } else {
      // 取消或直接关闭弹窗：回退设置
      await this.rollbackLocationConfig(oldLocation);
    }
  }

  /**
   * 回退 storageLocation 配置到旧值
   */
  private async rollbackLocationConfig(oldLocation: 'vscode' | 'root'): Promise<void> {
    this.isSwitchingLocation = true;
    try {
      const config = vscode.workspace.getConfiguration('xmark');
      const inspect = config.inspect<'vscode' | 'root'>('storageLocation');
      let target = vscode.ConfigurationTarget.Workspace;
      if (inspect?.workspaceFolderValue !== undefined) {
        target = vscode.ConfigurationTarget.WorkspaceFolder;
      } else if (inspect?.workspaceValue !== undefined) {
        target = vscode.ConfigurationTarget.Workspace;
      } else if (inspect?.globalValue !== undefined) {
        target = vscode.ConfigurationTarget.Global;
      }
      await config.update('storageLocation', oldLocation, target);
    } catch (err) {
      console.error('[XMark] 回退 storageLocation 配置失败:', err);
    } finally {
      this.isSwitchingLocation = false;
    }
  }

  /**
   * 初始化文件监听器 (兼容多根工作区与绝对文件目录)
   */
  private initWatcher(): void {
    this.fileWatcher?.dispose();

    const targetUri = this.getStorageUri();
    if (!targetUri) {
      return;
    }

    const watchDir = vscode.Uri.file(path.dirname(targetUri.fsPath));
    const fileName = path.basename(targetUri.fsPath);

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(watchDir, fileName)
    );

    this.fileWatcher.onDidChange(() => this.handleExternalChange());
    this.fileWatcher.onDidCreate(() => this.handleExternalChange());
    this.fileWatcher.onDidDelete(() => {
      this.schema.bookmarks = [];
      this.schema.groups = [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }];
      this._onDidChangeData.fire();
    });
  }

  private handleExternalChange(): void {
    if (this.isInternalWriting) {
      return;
    }
    this.loadFromDisk();
  }

  /**
   * 从磁盘加载并规范化数据
   */
  public async loadFromDisk(): Promise<void> {
    const storageUri = this.getStorageUri();
    if (!storageUri) {
      return;
    }

    try {
      const content = await fs.readFile(storageUri.fsPath, 'utf-8');
      const raw = JSON.parse(content);
      this.schema = this.sanitize(raw);
      this._onDidChangeData.fire();
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        await this.flushToDisk();
      } else {
        console.warn('[XMark] 解析 bookmark.json 失败，保留当前内存数据:', err);
      }
    }
  }

  /**
   * 数据清洗与健壮性兜底
   */
  private sanitize(raw: any): IBookmarkStorageSchema {
    const groups: IBookmarkGroup[] = Array.isArray(raw?.groups) && raw.groups.length > 0
      ? raw.groups
      : [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }];

    const groupIds = new Set(groups.map((g) => g.id));
    if (!groupIds.has(DEFAULT_GROUP_ID)) {
      groups.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 });
      groupIds.add(DEFAULT_GROUP_ID);
    }

    const bookmarks: IBookmark[] = Array.isArray(raw?.bookmarks)
      ? raw.bookmarks.map((bm: any, index: number) => ({
          id: String(bm.id || `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
          groupId: groupIds.has(bm.groupId) ? String(bm.groupId) : DEFAULT_GROUP_ID,
          name: String(bm.name || '未命名书签'),
          filePath: typeof bm.filePath === 'string' ? bm.filePath.replace(/\\/g, '/') : '',
          line: typeof bm.line === 'number' && bm.line > 0 ? bm.line : 1,
          commit: String(bm.commit || ''),
          lineHash: String(bm.lineHash || ''),
          order: typeof bm.order === 'number' ? bm.order : index,
          createdAt: typeof bm.createdAt === 'number' ? bm.createdAt : Date.now()
        }))
      : [];

    return {
      version: 1,
      defaultGroupId: DEFAULT_GROUP_ID,
      groups,
      bookmarks
    };
  }

  public scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.flushToDisk();
    }, 150);
  }

  public async flushToDisk(): Promise<void> {
    const storageUri = this.getStorageUri();
    if (!storageUri) {
      return;
    }

    try {
      this.isInternalWriting = true;
      const dir = path.dirname(storageUri.fsPath);
      await fs.mkdir(dir, { recursive: true });

      const content = JSON.stringify(this.schema, null, 2);
      await fs.writeFile(storageUri.fsPath, content, 'utf-8');
    } catch (error) {
      console.error('[XMark] 写入 bookmark.json 失败:', error);
    } finally {
      setTimeout(() => {
        this.isInternalWriting = false;
      }, 300);
      this._onDidChangeData.fire();
    }
  }

  // --- 书签 CRUD 操作 ---

  public getGroups(): IBookmarkGroup[] {
    return [...this.schema.groups].sort((a, b) => a.order - b.order);
  }

  public getBookmarks(groupId?: string): IBookmark[] {
    const list = groupId
      ? this.schema.bookmarks.filter((bm) => bm.groupId === groupId)
      : this.schema.bookmarks;
    return [...list].sort((a, b) => a.order - b.order);
  }

  public getBookmarkById(id: string): IBookmark | undefined {
    return this.schema.bookmarks.find((b) => b.id === id);
  }

  public getSnapshot(): IBookmarkStorageSchema {
    return JSON.parse(JSON.stringify(this.schema));
  }

  /**
   * 《核心位置》：多工作区相对路径规范化
   * 逻辑解释：
   * 采用 VS Code 原生 asRelativePath：
   * - 存在多个工作区或显式工作区文件时，保留子工程文件夹名前缀；
   * - 统一转换为 POSIX 正斜杠 / 格式，彻底消除 Windows 反斜杠。
   */
  public normalizeRelativePath(input: vscode.Uri | string): string {
    const uri = input instanceof vscode.Uri ? input : vscode.Uri.file(input);
    const folders = vscode.workspace.workspaceFolders;
    const isMultiRoot = (folders && folders.length > 1) || !!vscode.workspace.workspaceFile;
    return vscode.workspace.asRelativePath(uri, isMultiRoot).replace(/\\/g, '/');
  }

  /**
   * 《核心位置》：将书签相对路径转换为目标文件的准确 vscode.Uri
   * 逻辑解释：
   * 1. 严格遵守“禁止向下兼容代码”准则，去除历史数据的试探与探测循环。
   * 2. 多根工作区：路径规范为 `${folderName}/${relPath}`，拆解首段直接定位对应子工作区。
   * 3. 单根工作区：路径直接相对于当前工作区根目录拼接。
   */
  public resolveFileUri(relPath: string): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    const normalized = relPath.replace(/\\/g, '/');
    const isMultiRoot = folders.length > 1 || !!vscode.workspace.workspaceFile;

    if (isMultiRoot) {
      const slashIndex = normalized.indexOf('/');
      if (slashIndex !== -1) {
        const folderName = normalized.slice(0, slashIndex);
        const subPath = normalized.slice(slashIndex + 1);
        const matchedFolder = folders.find((f) => f.name === folderName);
        if (matchedFolder) {
          return vscode.Uri.joinPath(matchedFolder.uri, subPath);
        }
      }
    }

    return vscode.Uri.joinPath(folders[0].uri, normalized);
  }

  public async addBookmark(params: {
    filePath: string;
    line: number;
    name?: string;
    groupName?: string;
    groupId?: string;
    commit?: string;
    lineHash?: string;
  }): Promise<IBookmark> {
    let targetGroupId = params.groupId;

    if (!targetGroupId && params.groupName) {
      const existing = this.schema.groups.find((g) => g.name === params.groupName);
      if (existing) {
        targetGroupId = existing.id;
      } else {
        const newGroup = await this.addGroup(params.groupName);
        targetGroupId = newGroup.id;
      }
    }

    if (!targetGroupId || !this.schema.groups.some((g) => g.id === targetGroupId)) {
      targetGroupId = DEFAULT_GROUP_ID;
    }

    const groupBookmarks = this.getBookmarks(targetGroupId);
    const maxOrder = groupBookmarks.length > 0 ? Math.max(...groupBookmarks.map((b) => b.order)) + 1 : 0;

    const newBookmark: IBookmark = {
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      groupId: targetGroupId,
      name: params.name || `${params.filePath}:${params.line}`,
      filePath: params.filePath.replace(/\\/g, '/'),
      line: params.line,
      commit: params.commit || '',
      lineHash: params.lineHash || '',
      order: maxOrder,
      createdAt: Date.now()
    };

    this.schema.bookmarks.push(newBookmark);
    this.scheduleSave();
    return newBookmark;
  }

  public updateBookmark(id: string, updates: Partial<Pick<IBookmark, 'name' | 'line' | 'commit' | 'lineHash' | 'groupId' | 'order'>>): boolean {
    const bm = this.schema.bookmarks.find((b) => b.id === id);
    if (!bm) {
      return false;
    }

    Object.assign(bm, updates);
    this.scheduleSave();
    return true;
  }

  public deleteBookmark(id: string): boolean {
    const prevLen = this.schema.bookmarks.length;
    this.schema.bookmarks = this.schema.bookmarks.filter((b) => b.id !== id);
    if (this.schema.bookmarks.length !== prevLen) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /**
   * 获取指定文件 Uri 在当前存储中的所有书签行号列表
   */
  public getBookmarkedLinesForUri(uri: vscode.Uri): number[] {
    const relPath = this.normalizeRelativePath(uri);
    return Array.from(
      new Set(
        this.schema.bookmarks
          .filter((b) => {
            if (b.filePath === relPath) {
              return true;
            }
            const bUri = this.resolveFileUri(b.filePath);
            return bUri?.fsPath === uri.fsPath;
          })
          .map((b) => b.line)
      )
    );
  }

  public async addGroup(name: string): Promise<IBookmarkGroup> {
    const trimmed = name.trim();
    const existing = this.schema.groups.find((g) => g.name === trimmed);
    if (existing) {
      return existing;
    }

    const maxOrder = this.schema.groups.length > 0 ? Math.max(...this.schema.groups.map((g) => g.order)) + 1 : 0;
    const group: IBookmarkGroup = {
      id: `group_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      order: maxOrder
    };

    this.schema.groups.push(group);
    this.scheduleSave();
    return group;
  }

  public renameGroup(groupId: string, newName: string): boolean {
    const group = this.schema.groups.find((g) => g.id === groupId);
    if (!group) {
      return false;
    }
    group.name = newName.trim();
    this.scheduleSave();
    return true;
  }

  public getDefaultGroupId(): string {
    return this.schema.defaultGroupId || DEFAULT_GROUP_ID;
  }

  public setDefaultGroupId(groupId: string): boolean {
    const exists = this.schema.groups.some((g) => g.id === groupId);
    if (!exists) {
      return false;
    }
    this.schema.defaultGroupId = groupId;
    this.scheduleSave();
    return true;
  }

  public deleteGroup(groupId: string, moveToDefault: boolean): boolean {
    if (groupId === DEFAULT_GROUP_ID || groupId === this.getDefaultGroupId()) {
      return false;
    }

    this.schema.groups = this.schema.groups.filter((g) => g.id !== groupId);

    const fallbackGroupId = this.getDefaultGroupId();

    if (moveToDefault) {
      for (const bm of this.schema.bookmarks) {
        if (bm.groupId === groupId) {
          bm.groupId = fallbackGroupId;
        }
      }
    } else {
      this.schema.bookmarks = this.schema.bookmarks.filter((bm) => bm.groupId !== groupId);
    }

    this.scheduleSave();
    return true;
  }

  public moveBookmarkToGroup(bookmarkId: string, targetGroupId: string, targetOrder?: number): boolean {
    const bm = this.schema.bookmarks.find((b) => b.id === bookmarkId);
    if (!bm) {
      return false;
    }

    bm.groupId = targetGroupId;
    if (typeof targetOrder === 'number') {
      bm.order = targetOrder;
    } else {
      const groupBookmarks = this.getBookmarks(targetGroupId);
      bm.order = groupBookmarks.length > 0 ? Math.max(...groupBookmarks.map((b) => b.order)) + 1 : 0;
    }

    this.scheduleSave();
    return true;
  }

  public reorderBookmarks(groupId: string, orderedBookmarkIds: string[]): void {
    orderedBookmarkIds.forEach((id, index) => {
      const bm = this.schema.bookmarks.find((b) => b.id === id);
      if (bm && bm.groupId === groupId) {
        bm.order = index;
      }
    });
    this.scheduleSave();
  }

  public dispose(): void {
    this._onDidChangeData.dispose();
    this.fileWatcher?.dispose();
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
