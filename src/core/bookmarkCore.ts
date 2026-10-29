import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  IBookmark,
  IBookmarkGroup,
  IBookmarkStorageSchema,
  IDriftStatus
} from '../types.js';
import { computeLineHash } from './hashUtil.js';
import { getHeadCommit } from './gitHelper.js';

export const DEFAULT_INSTRUCTIONS =
  '【XMark AI 操作指南 / AI Agent Guidelines】1. 请勿删除此字段与 groups 中的 default 分组；2. 新增书签的 groupId 必须匹配 groups 中的 id；3. filePath 必须使用 POSIX 正斜杠 /；4. lineHash 为目标行去除首尾空格后的 16 位 SHA-256 Hash 值；5. 行号 line 为 1-based 正整数。';

/**
 * 《核心位置》：无宿主依赖的纯 Node.js 书签数据内核管理器
 * 逻辑解释：
 * 1. 抽离自 VS Code 插件宿主环境，供 MCP 服务与 VS Code 插件核心公共复用。
 * 2. 统一管理 bookmark.json 的磁盘加载、增删改查、数据清洗 (sanitize) 与保存逻辑。
 * 3. 内置流式代码行读取、SHA-256 哈希计算与代码漂移 (Drift) 检测。
 * 隐患点：并发写入时需避免文件竞争，保存时使用临时文件原子替换或目录自动创建。
 */
export class BookmarkCore {
  private workspaceRoot: string;
  private storageLocation: 'vscode' | 'root';
  private schema: IBookmarkStorageSchema;

  constructor(workspaceRoot: string, storageLocation: 'vscode' | 'root' = 'vscode') {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.storageLocation = storageLocation;
    this.schema = {
      _instructions: DEFAULT_INSTRUCTIONS,
      version: 1,
      defaultGroupId: DEFAULT_GROUP_ID,
      groups: [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }],
      bookmarks: []
    };
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public setWorkspaceRoot(newRoot: string): void {
    this.workspaceRoot = path.resolve(newRoot);
  }

  public setStorageLocation(loc: 'vscode' | 'root'): void {
    this.storageLocation = loc;
  }

  /**
   * 获取存储文件 bookmark.json 的绝对路径
   */
  public getStoragePath(): string {
    if (this.storageLocation === 'root') {
      return path.join(this.workspaceRoot, 'bookmark.json');
    }
    return path.join(this.workspaceRoot, '.vscode', 'bookmark.json');
  }

  /**
   * 从磁盘加载书签数据并规范化
   */
  public async load(): Promise<IBookmarkStorageSchema> {
    const filePath = this.getStoragePath();
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const raw = JSON.parse(content);
      this.schema = this.sanitize(raw);
      return this.schema;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // 文件不存在时初始化写入默认结构
        await this.save();
        return this.schema;
      }
      console.warn(`[BookmarkCore] 读取 ${filePath} 失败，保留当前状态:`, err.message);
      return this.schema;
    }
  }

  /**
   * 将当前书签结构持久化到磁盘
   */
  public async save(schemaToSave?: IBookmarkStorageSchema): Promise<void> {
    if (schemaToSave) {
      this.schema = this.sanitize(schemaToSave);
    }
    const targetPath = this.getStoragePath();
    const dir = path.dirname(targetPath);

    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(this.schema, null, 2);

    // 采用写入临时文件再原子重命名的方式，防止进程并发中断产生损坏文件
    const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // 忽略临时文件删除异常
      }
      // 降级使用普通写入
      await fs.writeFile(targetPath, content, 'utf-8');
    }
  }

  /**
   * 数据结构校验与兜底清洗
   */
  public sanitize(raw: any): IBookmarkStorageSchema {
    const groups: IBookmarkGroup[] =
      Array.isArray(raw?.groups) && raw.groups.length > 0
        ? raw.groups
        : [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 }];

    const groupIds = new Set(groups.map((g) => g.id));
    if (!groupIds.has(DEFAULT_GROUP_ID)) {
      groups.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 });
      groupIds.add(DEFAULT_GROUP_ID);
    }

    const bookmarks: IBookmark[] = Array.isArray(raw?.bookmarks)
      ? raw.bookmarks
          .filter((bm: any) => bm && typeof bm.filePath === 'string' && typeof bm.line === 'number')
          .map((bm: any) => {
            const safeGroupId = groupIds.has(bm.groupId) ? bm.groupId : DEFAULT_GROUP_ID;
            return {
              id: String(bm.id || `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
              groupId: safeGroupId,
              name: String(bm.name || `${bm.filePath}:${bm.line}`),
              filePath: String(bm.filePath).replace(/\\/g, '/'),
              line: Number(bm.line) || 1,
              commit: String(bm.commit || ''),
              lineHash: String(bm.lineHash || ''),
              order: typeof bm.order === 'number' ? bm.order : 0,
              createdAt: typeof bm.createdAt === 'number' ? bm.createdAt : Date.now()
            };
          })
      : [];

    return {
      _instructions: DEFAULT_INSTRUCTIONS,
      version: 1,
      defaultGroupId: DEFAULT_GROUP_ID,
      groups: groups.map((g, idx) => ({
        id: String(g.id),
        name: String(g.name || '未命名分组'),
        order: typeof g.order === 'number' ? g.order : idx
      })),
      bookmarks
    };
  }

  /**
   * 流式按需提取指定文件的目标代码行内容
   */
  public async getLineContent(relFilePath: string, targetLine: number): Promise<string> {
    const normalized = relFilePath.replace(/\\/g, '/');
    const absolutePath = path.isAbsolute(normalized)
      ? normalized
      : path.join(this.workspaceRoot, normalized);

    if (!fsSync.existsSync(absolutePath)) {
      return '';
    }

    return new Promise<string>((resolve) => {
      let resolved = false;
      const stream = fsSync.createReadStream(absolutePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let currentLine = 0;

      rl.on('line', (line) => {
        currentLine++;
        if (currentLine === targetLine) {
          resolved = true;
          rl.close();
          stream.destroy();
          resolve(line);
        }
      });

      rl.on('close', () => {
        if (!resolved) {
          resolve('');
        }
      });

      rl.on('error', () => {
        if (!resolved) {
          resolve('');
        }
      });
    });
  }

  /**
   * 获取指定代码行的内容与 16 位短哈希
   */
  public async getLineContentAndHash(
    relFilePath: string,
    targetLine: number
  ): Promise<{ content: string; hash: string }> {
    const content = await this.getLineContent(relFilePath, targetLine);
    const hash = computeLineHash(content);
    return { content, hash };
  }

  /**
   * 添加新书签 (自动计算 Hash 与 Git 提交)
   */
  public async addBookmark(params: {
    filePath: string;
    line: number;
    name?: string;
    groupId?: string;
    groupName?: string;
    commit?: string;
    lineHash?: string;
    autoCompute?: boolean;
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
    const maxOrder =
      groupBookmarks.length > 0 ? Math.max(...groupBookmarks.map((b) => b.order)) + 1 : 0;

    let lineHash = params.lineHash;
    let commit = params.commit;

    if (params.autoCompute !== false) {
      if (!lineHash) {
        const { hash } = await this.getLineContentAndHash(params.filePath, params.line);
        lineHash = hash;
      }
      if (!commit) {
        commit = await getHeadCommit(this.workspaceRoot);
      }
    }

    const newBookmark: IBookmark = {
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      groupId: targetGroupId,
      name: params.name || `${params.filePath}:${params.line}`,
      filePath: params.filePath.replace(/\\/g, '/'),
      line: params.line,
      commit: commit || '',
      lineHash: lineHash || '',
      order: maxOrder,
      createdAt: Date.now()
    };

    this.schema.bookmarks.push(newBookmark);
    await this.save();
    return newBookmark;
  }

  /**
   * 更新书签属性 (支持行号变动后自动刷新内容哈希)
   */
  public async updateBookmark(
    id: string,
    updates: Partial<Pick<IBookmark, 'name' | 'line' | 'commit' | 'lineHash' | 'groupId' | 'order'>> & {
      refreshHash?: boolean;
    }
  ): Promise<IBookmark | null> {
    const bm = this.schema.bookmarks.find((b) => b.id === id);
    if (!bm) {
      return null;
    }

    if (updates.groupId && !this.schema.groups.some((g) => g.id === updates.groupId)) {
      updates.groupId = DEFAULT_GROUP_ID;
    }

    Object.assign(bm, updates);

    if (updates.refreshHash || (updates.line && !updates.lineHash)) {
      const { hash } = await this.getLineContentAndHash(bm.filePath, bm.line);
      bm.lineHash = hash;
    }

    await this.save();
    return bm;
  }

  /**
   * 删除书签
   */
  public async deleteBookmark(id: string): Promise<boolean> {
    const prevLen = this.schema.bookmarks.length;
    this.schema.bookmarks = this.schema.bookmarks.filter((b) => b.id !== id);
    if (this.schema.bookmarks.length !== prevLen) {
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * 查询所有书签或指定分组书签
   */
  public getBookmarks(groupId?: string): IBookmark[] {
    if (groupId) {
      return this.schema.bookmarks
        .filter((b) => b.groupId === groupId)
        .sort((a, b) => a.order - b.order);
    }
    return [...this.schema.bookmarks].sort((a, b) => a.order - b.order);
  }

  public getBookmark(id: string): IBookmark | undefined {
    return this.schema.bookmarks.find((b) => b.id === id);
  }

  /**
   * 检测书签的代码漂移状态
   */
  public async checkDrift(id: string): Promise<IDriftStatus | null> {
    const bm = this.getBookmark(id);
    if (!bm) {
      return null;
    }
    const currentLine = await this.getLineContent(bm.filePath, bm.line);
    const currentHash = computeLineHash(currentLine);
    const contentChanged = bm.lineHash !== currentHash;
    return {
      hasChanged: contentChanged,
      contentChanged
    };
  }

  /**
   * 分组管理：获取分组列表
   */
  public listGroups(): IBookmarkGroup[] {
    return [...this.schema.groups].sort((a, b) => a.order - b.order);
  }

  /**
   * 分组管理：添加新分组
   */
  public async addGroup(name: string, customId?: string): Promise<IBookmarkGroup> {
    const id =
      customId ||
      `group_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const maxOrder =
      this.schema.groups.length > 0
        ? Math.max(...this.schema.groups.map((g) => g.order)) + 1
        : 0;

    const newGroup: IBookmarkGroup = {
      id,
      name,
      order: maxOrder
    };

    this.schema.groups.push(newGroup);
    await this.save();
    return newGroup;
  }

  /**
   * 分组管理：更新分组名称与排序
   */
  public async updateGroup(
    id: string,
    updates: Partial<Pick<IBookmarkGroup, 'name' | 'order'>>
  ): Promise<boolean> {
    const group = this.schema.groups.find((g) => g.id === id);
    if (!group) {
      return false;
    }
    if (updates.name !== undefined) {
      group.name = updates.name;
    }
    if (updates.order !== undefined) {
      group.order = updates.order;
    }
    await this.save();
    return true;
  }

  /**
   * 分组管理：删除分组 (组内书签归入 default)
   */
  public async deleteGroup(id: string): Promise<boolean> {
    if (id === DEFAULT_GROUP_ID) {
      return false; // 默认分组不允许删除
    }
    const exists = this.schema.groups.some((g) => g.id === id);
    if (!exists) {
      return false;
    }

    // 将属于该分组的书签重置为默认分组
    for (const bm of this.schema.bookmarks) {
      if (bm.groupId === id) {
        bm.groupId = DEFAULT_GROUP_ID;
      }
    }

    this.schema.groups = this.schema.groups.filter((g) => g.id !== id);
    await this.save();
    return true;
  }

  /**
   * 获取当前完整数据架构
   */
  public getSchema(): IBookmarkStorageSchema {
    return JSON.parse(JSON.stringify(this.schema));
  }
}

export { BookmarkCore as StandaloneBookmarkManager };

