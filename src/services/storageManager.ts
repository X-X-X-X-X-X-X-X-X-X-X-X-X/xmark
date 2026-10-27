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

const DEFAULT_INSTRUCTIONS =
  '【XMark AI 操作指南】1. 请勿删除此字段与 groups 中的 default 分组；2. 新增书签的 groupId 必须匹配 groups 中的 id；3. filePath 必须使用 POSIX 正斜杠 /；4. lineHash 为目标行去除首尾空格后的 16 位 SHA-256 Hash 值；5. 行号 line 为 1-based 正整数。';

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
    _instructions: DEFAULT_INSTRUCTIONS,
    version: 1,
    defaultGroupId: DEFAULT_GROUP_ID,
    groups: [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }],
    bookmarks: []
  };

  private fileWatcher?: vscode.FileSystemWatcher;
  private isInternalWriting = false;
  private saveTimeout?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.initWatcher();
    this.loadFromDisk();

    // 监听设置变更 (如 storageLocation 改变) 与工作区目录变动
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('xmark.storageLocation')) {
          this.initWatcher();
          this.loadFromDisk();
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
   */
  public getStorageUri(): vscode.Uri | undefined {
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

    const config = vscode.workspace.getConfiguration('xmark');
    const location = config.get<string>('storageLocation', 'vscode');

    if (location === 'root') {
      return vscode.Uri.joinPath(rootUri, 'bookmark.json');
    }
    return vscode.Uri.joinPath(rootUri, '.vscode', 'bookmark.json');
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
      _instructions: raw?._instructions || DEFAULT_INSTRUCTIONS,
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
