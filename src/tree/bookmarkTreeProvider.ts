import * as vscode from 'vscode';
import { IBookmark, IBookmarkGroup } from '../types.js';
import { StorageManager } from '../services/storageManager.js';
import { GitService } from '../services/gitService.js';
import { checkBookmarkDrift } from '../services/driftChecker.js';
import { BookmarkTreeItem, GroupTreeItem, XMarkTreeItem, getGroupDisplayName } from './treeItems.js';

export interface ISearchBookmarkEntry {
  bookmark: IBookmark;
  group?: IBookmarkGroup;
  groupDisplayName: string;
  isDefaultGroup: boolean;
}

/**
 * 《核心位置》：书签综合模糊搜索匹配函数（QuickPick 与侧边栏树筛选共享同一匹配契约）
 * 逻辑解释：
 * 1. 支持按空白字符拆分为多关键字 AND 匹配，大小写不敏感。
 * 2. 同时覆盖书签名称、相对文件路径:行号、分组国际化显示名及分组原始名称，确保中英文环境下均可命中。
 * 3. 采用纯子串匹配 (String.includes)，避免动态正则编译及 ReDoS 风险。
 * 隐患点：若书签数量达到万级规模，每次输入全量拼接字符串可能产生一定 CPU 占用。
 */
export function matchesBookmarkQuery(
  bookmark: IBookmark,
  groupDisplayName: string,
  groupRawName: string,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const tokens = normalized.split(/\s+/);
  const haystack = `${bookmark.name}\n${bookmark.filePath}:${bookmark.line}\n${groupDisplayName}\n${groupRawName}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/*
 * 《核心位置》：侧边栏书签树视图数据驱动提供者 (支持反向定位、父级回溯与搜索筛选)
 * 逻辑解释：
 * 1. 根节点呈现用户自定义与默认的分组列表；当处于搜索筛选态时仅展示含命中书签的分组并自动展开。
 * 2. 展开分组时，通过 Promise.all 并行加载组内所有匹配书签并异步比对当前文件的代码行 Hash。
 * 3. 实现 getParent(element) 契约，支持 TreeView.reveal 自动展开父级分组并滚动高亮定位目标书签。
 * 4. 维护 itemCache 节点引用缓存，保证 reveal 查找与树视图内部节点引用和 id 严格一致。
 * 5. 监听 Storage、GitService 以及文档保存事件 (onDidSaveTextDocument)，实现行号图标与侧边栏列表的毫秒级同步刷新。
 * 隐患点：数据变更或文档保存触发 refresh 时必须清空 itemCache，防止陈旧书签引用导致视图状态滞后；筛选切换需同步更新 xmark.hasSearchFilter 与 treeView.message。
 */
export class BookmarkTreeProvider implements vscode.TreeDataProvider<XMarkTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<XMarkTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private disposables: vscode.Disposable[] = [];
  private itemCache = new Map<string, BookmarkTreeItem>();
  private searchFilter = '';
  private treeView?: vscode.TreeView<XMarkTreeItem>;

  constructor(
    private extensionUri: vscode.Uri,
    private storage: StorageManager,
    private git: GitService
  ) {
    this.disposables.push(
      this.storage.onDidChangeData(() => this.refresh()),
      this.git.onDidChange(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file' && this.storage.getBookmarkedLinesForUri(doc.uri).length > 0) {
          this.refresh();
        }
      })
    );
  }

  public attachTreeView(treeView: vscode.TreeView<XMarkTreeItem>): void {
    this.treeView = treeView;
    this.syncFilterUiState();
  }

  public getSearchFilter(): string {
    return this.searchFilter;
  }

  public setSearchFilter(query: string): void {
    const trimmed = query.trim();
    if (this.searchFilter === trimmed) {
      return;
    }
    this.searchFilter = trimmed;
    this.refresh();
  }

  public clearSearchFilter(): void {
    this.setSearchFilter('');
  }

  public searchBookmarks(query: string): ISearchBookmarkEntry[] {
    const groups = this.storage.getGroups();
    const defaultGroupId = this.storage.getDefaultGroupId();
    const groupMap = new Map<string, IBookmarkGroup>(groups.map((g) => [g.id, g]));
    const seenIds = new Set<string>();
    const results: ISearchBookmarkEntry[] = [];

    for (const group of groups) {
      const displayName = getGroupDisplayName(group);
      const bookmarks = this.storage.getBookmarks(group.id);
      for (const bm of bookmarks) {
        seenIds.add(bm.id);
        if (matchesBookmarkQuery(bm, displayName, group.name, query)) {
          results.push({
            bookmark: bm,
            group,
            groupDisplayName: displayName,
            isDefaultGroup: group.id === defaultGroupId
          });
        }
      }
    }

    for (const bm of this.storage.getBookmarks()) {
      if (seenIds.has(bm.id)) {
        continue;
      }
      const group = groupMap.get(bm.groupId);
      const displayName = getGroupDisplayName(group) || bm.groupId;
      const rawName = group?.name || bm.groupId;
      if (matchesBookmarkQuery(bm, displayName, rawName, query)) {
        results.push({
          bookmark: bm,
          group,
          groupDisplayName: displayName,
          isDefaultGroup: bm.groupId === defaultGroupId
        });
      }
    }

    return results;
  }

  public isBookmarkVisible(bookmarkId: string): boolean {
    if (!this.searchFilter) {
      return true;
    }
    const bm = this.storage.getBookmarkById(bookmarkId);
    if (!bm) {
      return false;
    }
    const group = this.storage.getGroups().find((g) => g.id === bm.groupId);
    const displayName = getGroupDisplayName(group) || bm.groupId;
    return matchesBookmarkQuery(bm, displayName, group?.name || bm.groupId, this.searchFilter);
  }

  private syncFilterUiState(): void {
    const hasFilter = Boolean(this.searchFilter);
    vscode.commands.executeCommand('setContext', 'xmark.hasSearchFilter', hasFilter);

    if (!this.treeView) {
      return;
    }

    if (!hasFilter || !vscode.workspace.workspaceFolders?.length) {
      this.treeView.message = undefined;
      return;
    }

    const matchedCount = this.searchBookmarks(this.searchFilter).length;
    this.treeView.message =
      matchedCount > 0
        ? vscode.l10n.t('Filter: "{0}" ({1} match(es))', this.searchFilter, matchedCount)
        : vscode.l10n.t('No bookmarks matching "{0}"', this.searchFilter);
  }

  public refresh(): void {
    this.itemCache.clear();
    this.syncFilterUiState();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: XMarkTreeItem): vscode.TreeItem {
    return element;
  }

  /*
   * 《核心位置》：获取树节点的父级容器 (用于 TreeView.reveal 反向定位)
   * 逻辑解释：
   * 1. 当 element 为 BookmarkTreeItem 时，根据其 groupId 找到所属的 IBookmarkGroup 并构造 GroupTreeItem 返回。
   * 2. 当处于筛选态时同步传入匹配数与 filterKey，确保父节点 id 与 getChildren 返回节点完全一致。
   * 3. 当 element 为 GroupTreeItem 时，处于根层级，返回 undefined。
   */
  public getParent(element: XMarkTreeItem): vscode.ProviderResult<XMarkTreeItem> {
    if (element instanceof BookmarkTreeItem) {
      const groups = this.storage.getGroups();
      const targetGroup = groups.find((g) => g.id === element.bookmark.groupId);
      if (targetGroup) {
        const defaultGroupId = this.storage.getDefaultGroupId();
        const groupBookmarks = this.storage.getBookmarks(targetGroup.id);
        if (this.searchFilter) {
          const displayName = getGroupDisplayName(targetGroup);
          const matchedCount = groupBookmarks.filter((bm) =>
            matchesBookmarkQuery(bm, displayName, targetGroup.name, this.searchFilter)
          ).length;
          return new GroupTreeItem(
            targetGroup,
            matchedCount,
            targetGroup.id === defaultGroupId,
            this.searchFilter
          );
        }
        return new GroupTreeItem(
          targetGroup,
          groupBookmarks.length,
          targetGroup.id === defaultGroupId
        );
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

    // 根层级：返回所有分组（筛选模式下仅返回含命中书签的分组并自动展开）
    if (!element) {
      const groups = this.storage.getGroups();
      const defaultGroupId = this.storage.getDefaultGroupId();
      if (!this.searchFilter) {
        return groups.map((g) => {
          const count = this.storage.getBookmarks(g.id).length;
          return new GroupTreeItem(g, count, g.id === defaultGroupId);
        });
      }

      const filteredGroups: GroupTreeItem[] = [];
      for (const g of groups) {
        const displayName = getGroupDisplayName(g);
        const matched = this.storage
          .getBookmarks(g.id)
          .filter((bm) => matchesBookmarkQuery(bm, displayName, g.name, this.searchFilter));
        if (matched.length > 0) {
          filteredGroups.push(
            new GroupTreeItem(g, matched.length, g.id === defaultGroupId, this.searchFilter)
          );
        }
      }
      return filteredGroups;
    }

    // 分组展开层级：并行返回组内的所有书签（筛选模式下过滤出命中项）
    if (element instanceof GroupTreeItem) {
      let bookmarks = this.storage.getBookmarks(element.group.id);
      if (this.searchFilter) {
        const displayName = getGroupDisplayName(element.group);
        bookmarks = bookmarks.filter((bm) =>
          matchesBookmarkQuery(bm, displayName, element.group.name, this.searchFilter)
        );
      }

      return Promise.all(
        bookmarks.map(async (bm) => {
          let item = this.itemCache.get(bm.id);
          if (!item) {
            const fileUri = this.storage.resolveFileUri(bm.filePath);
            const drift = await checkBookmarkDrift(bm, fileUri);
            item = new BookmarkTreeItem(bm, drift, fileUri, this.extensionUri);
            this.itemCache.set(bm.id, item);
          }
          return item;
        })
      );
    }

    return [];
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
