import * as vscode from 'vscode';
import { StorageManager } from '../services/storageManager.js';
import { GitService } from '../services/gitService.js';
import { checkBookmarkDrift } from '../services/driftChecker.js';
import { BookmarkTreeItem, GroupTreeItem, XMarkTreeItem } from './treeItems.js';

/*
 * 《核心位置》：侧边栏书签树视图数据驱动提供者
 * 逻辑解释：
 * 1. 根节点呈现用户自定义与默认的分组列表。
 * 2. 展开分组时，加载组内所有书签，并异步比对当前文件的 Git Commit 及行 Hash。
 * 3. 监听 Storage 与 GitService 事件，实现毫秒级局部刷新与状态同步。
 */
export class BookmarkTreeProvider implements vscode.TreeDataProvider<XMarkTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<XMarkTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private disposables: vscode.Disposable[] = [];

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
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: XMarkTreeItem): vscode.TreeItem {
    return element;
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
        const fileUri = this.storage.resolveFileUri(bm.filePath);
        const headCommit = await this.git.getHeadCommit(fileUri);
        const drift = await checkBookmarkDrift(bm, headCommit, fileUri);
        items.push(new BookmarkTreeItem(bm, drift, fileUri, this.extensionUri));
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
