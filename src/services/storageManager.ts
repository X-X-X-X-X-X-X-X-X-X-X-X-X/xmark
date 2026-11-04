import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  IBookmark,
  IBookmarkGroup,
  IBookmarkStorageSchema,
  StorageLocation
} from '../types.js';
import {
  removeWorkspaceIndex,
  resolveWorkspaceStorageInfo,
  updateWorkspaceIndex
} from '../core/hashUtil.js';

/*
 * 《核心位置》：书签数据持久化与外部同步管理器 (按工作区独立控制 global ~/.xmark 与 root 根目录模式)
 * 逻辑解释：
 * 1. 自动识别：打开工作区时优先检测 workspaceFolders[0]/bookmark.json 是否存在；若存在则自动进入 'root' 模式，否则默认进入 'global' 模式 (~/.xmark/{pathHash}.json)。
 * 2. 独立切换：通过 switchStorageLocation 方法针对当前单个工作区在 'global' 与 'root' 之间迁移切换，绝不污染全局设置或其他项目，也不产生 .vscode/settings.json。
 * 3. 路径处理：基于 vscode.workspace.asRelativePath(uri, isMultiRoot) 统一规范化，多根工作区自动带上子项目名前缀。
 * 4. 具备内部写锁与 300ms 防抖，杜绝自身写入触发 FileSystemWatcher 造成的死循环与界面抖动。
 * 隐患点：在无工作区（未打开任何文件夹）的空窗口下需防御性退出，避免路径解析报错。
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
  private currentStorageLocation: StorageLocation = 'global';
  private isSwitchingLocation = false;

  constructor() {
    this.currentStorageLocation = this.detectInitialStorageLocation();
    this.initWatcher();
    this.loadFromDisk();

    // 监听工作区目录变动
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.currentStorageLocation = this.detectInitialStorageLocation();
        this.initWatcher();
        this.loadFromDisk();
      })
    );
  }

  /**
   * 获取当前工作区基准路径 (统一使用 workspaceFolders[0])
   */
  public getWorkspaceRootPath(): string | undefined {
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (!firstFolder || firstFolder.uri.scheme !== 'file') {
      return undefined;
    }
    return firstFolder.uri.fsPath;
  }

  /**
   * 自动探测当前工作区的存储模式：
   * 若工作区根目录下存在 bookmark.json，则使用 'root' 模式；否则默认使用 'global' (~/.xmark) 模式
   */
  private detectInitialStorageLocation(): StorageLocation {
    const rootPath = this.getWorkspaceRootPath();
    if (!rootPath) {
      return 'global';
    }
    const rootBookmarkFile = path.join(rootPath, 'bookmark.json');
    return fsSync.existsSync(rootBookmarkFile) ? 'root' : 'global';
  }

  public getStorageLocation(): StorageLocation {
    return this.currentStorageLocation;
  }

  /**
   * 《核心位置》：根据指定 location ('global' | 'root') 推导目标存储文件 Uri
   * 逻辑解释：
   * 1. 统一以 workspaceFolders[0] 的路径为基准，确保与 MCP 进程完全对齐。
   * 2. 'root' 模式指向工作区根目录下的 bookmark.json。
   * 3. 'global' 模式指向用户主目录 ~/.xmark/{pathHash}.json。
   * 隐患点：空工作区（未打开任何目录）将返回 undefined，调用方需做保护。
   */
  public getStorageUriForLocation(location: StorageLocation): vscode.Uri | undefined {
    const rootPath = this.getWorkspaceRootPath();
    if (!rootPath) {
      return undefined;
    }

    if (location === 'root') {
      return vscode.Uri.file(path.join(rootPath, 'bookmark.json'));
    }

    const { storageFilePath } = resolveWorkspaceStorageInfo(rootPath);
    return vscode.Uri.file(storageFilePath);
  }

  public getStorageUri(): vscode.Uri | undefined {
    return this.getStorageUriForLocation(this.currentStorageLocation);
  }

  /**
   * 《核心位置》：单工作区存储位置动态切换、自动迁移、index.json 同步与冲突决策
   * 逻辑解释：
   * 1. 状态防重：如果当前正在切换流程中，或者目标位置与当前已生效的 location 一致，则无需重复执行。
   * 2. 防抖落盘：若有处于防抖阶段的未写磁盘数据，先立即落盘至旧位置，确保数据一致。
   * 3. 目标无文件迁移：若新位置尚无书签文件，则将当前书签数据安全写入新位置，销毁旧 Watcher 后清理旧文件（保持单一真实源）。
   * 4. 冲突判定与决策弹窗：若新旧两处均存在文件，弹出 WarningMessage 供用户选择：载入新位置现有文件、用当前书签覆盖新位置、或取消切换。
   * 5. 索引维护：切换到 'global' 时注册更新 ~/.xmark/index.json；切换到 'root' 并清理旧文件时从 index.json 中移除该工作区记录。
   * 隐患点：在没有读写权限的工作区路径下，fs.unlink / fs.writeFile 可能抛错，需完善 try-catch 保护并输出日志。
   */
  public async switchStorageLocation(newLocation: StorageLocation): Promise<void> {
    if (this.isSwitchingLocation || newLocation === this.currentStorageLocation) {
      return;
    }

    this.isSwitchingLocation = true;
    try {
      // 若有正在防抖倒计时的落盘任务，先强制落盘至旧位置
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = undefined;
        await this.flushToDisk();
      }

      const rootPath = this.getWorkspaceRootPath();
      const oldLocation = this.currentStorageLocation;
      const oldUri = this.getStorageUriForLocation(oldLocation);
      const newUri = this.getStorageUriForLocation(newLocation);

      if (!rootPath || !oldUri || !newUri) {
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

      // 场景 1：目标新位置不存在书签文件（自动迁移旧数据并清理旧文件）
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

            if (oldLocation === 'global') {
              await removeWorkspaceIndex(rootPath);
            }
          } catch (err) {
            console.error('[XMark] 迁移存储文件至新位置失败:', err);
          }

          const targetName = newLocation === 'root'
            ? vscode.l10n.t('root directory (bookmark.json)')
            : vscode.l10n.t('~/.xmark directory');
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
        vscode.l10n.t('Both old and new locations have a bookmark file. How would you like to proceed?'),
        OPTION_LOAD_NEW,
        OPTION_OVERWRITE_NEW,
        OPTION_CANCEL
      );

      if (choice === OPTION_LOAD_NEW) {
        // 先销毁旧监听器，防止后续清理旧文件时触发 onDidDelete
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;

        this.currentStorageLocation = newLocation;
        this.initWatcher();
        await this.loadFromDisk();

        try {
          await fs.unlink(oldUri.fsPath);
          if (oldLocation === 'global') {
            await removeWorkspaceIndex(rootPath);
          }
        } catch (err) {
          console.warn('[XMark] 删除旧存储文件失败:', err);
        }

        const targetName = newLocation === 'root'
          ? vscode.l10n.t('root directory (bookmark.json)')
          : vscode.l10n.t('~/.xmark directory');
        vscode.window.showInformationMessage(
          vscode.l10n.t('Bookmark storage migrated to {0} and old file cleaned up', targetName)
        );
      } else if (choice === OPTION_OVERWRITE_NEW) {
        try {
          // 先销毁旧监听器，防止删除旧文件时触发 onDidDelete
          this.fileWatcher?.dispose();
          this.fileWatcher = undefined;

          await fs.mkdir(path.dirname(newUri.fsPath), { recursive: true });
          const content = JSON.stringify(this.schema, null, 2);
          await fs.writeFile(newUri.fsPath, content, 'utf-8');
          await fs.unlink(oldUri.fsPath);

          if (oldLocation === 'global') {
            await removeWorkspaceIndex(rootPath);
          }
        } catch (err) {
          console.error('[XMark] 覆盖新位置或清理旧文件失败:', err);
        }

        this.currentStorageLocation = newLocation;
        this.initWatcher();
        await this.loadFromDisk();

        vscode.window.showInformationMessage(
          vscode.l10n.t('New location overwritten with current bookmarks and old file cleaned up')
        );
      }
    } finally {
      this.isSwitchingLocation = false;
    }
  }

  /**
   * 初始化文件监听器 (监听当前激活的存储文件)
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
    const rootPath = this.getWorkspaceRootPath();
    const storageUri = this.getStorageUri();
    if (!rootPath || !storageUri) {
      return;
    }

    try {
      const content = await fs.readFile(storageUri.fsPath, 'utf-8');
      const raw = JSON.parse(content);
      this.schema = this.sanitize(raw);
      if (this.currentStorageLocation === 'global') {
        await updateWorkspaceIndex(rootPath);
      }
      this._onDidChangeData.fire();
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        await this.flushToDisk();
      } else {
        console.warn('[XMark] 解析书签存储文件失败，保留当前内存数据:', err);
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
    const rootPath = this.getWorkspaceRootPath();
    const storageUri = this.getStorageUri();
    if (!rootPath || !storageUri) {
      return;
    }

    try {
      this.isInternalWriting = true;
      const dir = path.dirname(storageUri.fsPath);
      await fs.mkdir(dir, { recursive: true });

      const content = JSON.stringify(this.schema, null, 2);
      await fs.writeFile(storageUri.fsPath, content, 'utf-8');

      if (this.currentStorageLocation === 'global') {
        await updateWorkspaceIndex(rootPath);
      }
    } catch (error) {
      console.error('[XMark] 写入书签存储文件失败:', error);
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
   * 《核心位置》：工作区相对路径规范化
   * 逻辑解释：
   * 采用 VS Code 原生 asRelativePath(uri, false)：
   * - 统一不附加工作区文件夹名前缀，与 MCP 端相对于工作区根目录的路径格式严格保持一致；
   * - 统一转换为 POSIX 正斜杠 / 格式，彻底消除 Windows 反斜杠。
   */
  public normalizeRelativePath(input: vscode.Uri | string): string {
    const uri = input instanceof vscode.Uri ? input : vscode.Uri.file(input);
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  /**
   * 《核心位置》：将书签相对路径转换为目标文件的准确 vscode.Uri
   * 逻辑解释：
   * 1. 优先在 workspaceFolders 中查找实际存在该相对路径文件的目录（兼容多根工作区下的不同子文件夹）。
   * 2. 默认拼接至 workspaceFolders[0].uri。
   */
  public resolveFileUri(relPath: string): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    const normalized = relPath.replace(/\\/g, '/');
    if (folders.length > 1) {
      for (const folder of folders) {
        const candidate = vscode.Uri.joinPath(folder.uri, normalized);
        if (fsSync.existsSync(candidate.fsPath)) {
          return candidate;
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
