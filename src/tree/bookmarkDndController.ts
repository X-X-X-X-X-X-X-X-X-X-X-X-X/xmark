import * as vscode from 'vscode';
import { StorageManager } from '../services/storageManager.js';
import { BookmarkTreeItem, GroupTreeItem, XMarkTreeItem } from './treeItems.js';

const MIME_TYPE = 'application/vnd.code.tree.xmarkBookmarkView';

/*
 * 《核心位置》：侧边栏树视图拖拽控制器
 * 逻辑解释：
 * 1. 实现 VS Code 原生 TreeDragAndDropController 接口。
 * 2. 支持单选/多选书签拖入目标分组（跨组归类）。
 * 3. 支持在分组内部或跨组拖拽到其他书签上方/下方进行精准排序（TreeDropPosition 处理）。
 * 隐患点：拖拽到自身或同位置时需做短路过滤，避免无意义的重排序触发磁盘落盘。
 */
export class BookmarkDndController implements vscode.TreeDragAndDropController<XMarkTreeItem> {
  public readonly dropMimeTypes = [MIME_TYPE];
  public readonly dragMimeTypes = [MIME_TYPE];

  constructor(private storage: StorageManager) {}

  public async handleDrag(
    source: readonly XMarkTreeItem[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const bookmarkIds = source
      .filter((item): item is BookmarkTreeItem => item instanceof BookmarkTreeItem)
      .map((item) => item.bookmark.id);

    if (bookmarkIds.length > 0) {
      dataTransfer.set(
        MIME_TYPE,
        new vscode.DataTransferItem(JSON.stringify({ bookmarkIds }))
      );
    }
  }

  public async handleDrop(
    target: XMarkTreeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = dataTransfer.get(MIME_TYPE);
    if (!item) {
      return;
    }

    let payload: { bookmarkIds: string[] };
    try {
      payload = JSON.parse(await item.asString());
    } catch {
      return;
    }

    const { bookmarkIds } = payload;
    if (!bookmarkIds?.length) {
      return;
    }

    // 情况 1: 拖拽到某个分组上 (直接归组到末尾)
    if (target instanceof GroupTreeItem) {
      for (const id of bookmarkIds) {
        this.storage.moveBookmarkToGroup(id, target.group.id);
      }
      return;
    }

    // 情况 2: 拖拽到某个书签附近 (重排序或跨组插入)
    if (target instanceof BookmarkTreeItem) {
      const targetGroup = target.bookmark.groupId;
      const groupBookmarks = this.storage.getBookmarks(targetGroup);
      const targetIndex = groupBookmarks.findIndex((b) => b.id === target.bookmark.id);

      if (targetIndex === -1) {
        return;
      }

      // 过滤掉原本就在当前位置的书签
      const activeList = groupBookmarks.filter((b) => !bookmarkIds.includes(b.id));
      
      // 插入到目标位置
      activeList.splice(targetIndex, 0, ...bookmarkIds.map((id) => this.storage.getBookmarkById(id)!));

      activeList.forEach((bm, idx) => {
        if (bm) {
          bm.groupId = targetGroup;
          bm.order = idx;
        }
      });

      this.storage.reorderBookmarks(
        targetGroup,
        activeList.filter(Boolean).map((b) => b.id)
      );
      return;
    }
  }
}
