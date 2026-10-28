import * as vscode from 'vscode';
import { StorageManager } from '../services/storageManager.js';
import { GitService } from '../services/gitService.js';
import { checkBookmarkDrift } from '../services/driftChecker.js';
import { BookmarkTreeItem, GroupTreeItem, XMarkTreeItem } from './treeItems.js';

/*
 * 《核心位置》：侧边栏书签树视图数据驱动提供者 (支持反向定位与父级回溯)
 * 逻辑解释：
 * 1. 根节点呈现用户自定义与默认的分组列表。
 * 2. 展开分组时，加载组内所有书签，并异步比对当前文件的 Git Commit 及行 Hash。
 * 3. 实现 getParent(element) 契约，支持 TreeView.reveal 自动展开父级分组并滚动高亮定位目标书签。
 * 4. 维护 itemCache 节点引用缓存，保证 reveal 查找与树视图内部节点引用和 id 严格一致。
 * 5. 监听 Storage 与 GitService 事件，实现毫秒级局部刷新与状态同步。
 * 隐患点：数据变更触发 refresh 时必须清空 itemCache，防止陈旧书签引用导致视图状态滞后。
 */
export class BookmarkTreeProvider implements vscode.TreeDataProvider<XMarkTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<XMarkTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private disposables: vscode.Disposable[] = [];
  private itemCache = new Map<string, BookmarkTreeItem>();

  constructor(
    private extensionUri: vscode.Uri,
    private storage: StorageManager,
    private git: GitService
  ) {
    this.disposables.push(
      this.storage.onDidChangeData(() => this.refresh()),
      this.git.onDidChange(() => this.refresh())
    );
  }

  public refresh(): void {
    this.itemCache.clear();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: XMarkTreeItem): vscode.TreeItem {
    return element;
  }

  /*
   * 《核心位置》：获取树节点的父级容器 (用于 TreeView.reveal 反向定位)
   * 逻辑解释：
   * 1. 当 element 为 BookmarkTreeItem 时，根据其 groupId 找到所属的 IBookmarkGroup 并构造 GroupTreeItem 返回。
   * 2. 当 element 为 GroupTreeItem 时，处于根层级，返回 undefined。
   */
  public getParent(element: XMarkTreeItem): vscode.ProviderResult<XMarkTreeItem> {
    if (element instanceof BookmarkTreeItem) {
      const groups = this.storage.getGroups();
      const targetGroup = groups.find((g) => g.id === element.bookmark.groupId);
      if (targetGroup) {
        const count = this.storage.getBookmarks(targetGroup.id).length;
        const defaultGroupId = this.storage.getDefaultGroupId();
        return new GroupTreeItem(targetGroup, count, targetGroup.id === defaultGroupId);
      }
    }
    return undefined;
  }

  /*
   * 《核心位置》：根据书签 ID 查找或构建对应的树节点
   * 逻辑解释：
   * 1. 优先从 itemCache 中获取已缓存的节点，确保引用与展开状态一致。
   * 2. 若未缓存，通过 storage 与 driftChecker 异步构建并写入缓存返回。
   */
  public async findBookmarkTreeItem(bookmarkId: string): Promise<BookmarkTreeItem | undefined> {
    const cached = this.itemCache.get(bookmarkId);
    if (cached) {
      return cached;
    }
    const allBookmarks = this.storage.getBookmarks();
    const bm = allBookmarks.find((b) => b.id === bookmarkId);
    if (!bm) {
      return undefined;
    }
    const fileUri = this.storage.resolveFileUri(bm.filePath);
    const drift = await checkBookmarkDrift(bm, fileUri);
    const item = new BookmarkTreeItem(bm, drift, fileUri, this.extensionUri);
    this.itemCache.set(bm.id, item);
    return item;
  }

  public async getChildren(element?: XMarkTreeItem): Promise<XMarkTreeItem[]> {
    // 若当前未打开任何工作区，返回空数组由 viewsWelcome 呈现原生不可操作提示
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return [];
    }

    // 根层级：返回所有分组
    if (!element) {
      const groups = this.storage.getGroups();
      const defaultGroupId = this.storage.getDefaultGroupId();
      return groups.map((g) => {
        const count = this.storage.getBookmarks(g.id).length;
        return new GroupTreeItem(g, count, g.id === defaultGroupId);
      });
    }

    // 分组展开层级：返回组内的所有书签
    if (element instanceof GroupTreeItem) {
      const bookmarks = this.storage.getBookmarks(element.group.id);

      const items: BookmarkTreeItem[] = [];
      for (const bm of bookmarks) {
        let item = this.itemCache.get(bm.id);
        if (!item) {
          const fileUri = this.storage.resolveFileUri(bm.filePath);
          const drift = await checkBookmarkDrift(bm, fileUri);
          item = new BookmarkTreeItem(bm, drift, fileUri, this.extensionUri);
          this.itemCache.set(bm.id, item);
        }
        items.push(item);
      }
      return items;
    }

    return [];
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
