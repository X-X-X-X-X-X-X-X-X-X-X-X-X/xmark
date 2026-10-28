import * as vscode from 'vscode';
import { StorageManager } from '../services/storageManager.js';
import { GitService } from '../services/gitService.js';
import { computeLineHash, getLineContent } from '../services/driftChecker.js';
import { BookmarkTreeItem, GroupTreeItem } from '../tree/treeItems.js';
import { DEFAULT_GROUP_ID, IBookmark, IBookmarkGroup } from '../types.js';

/**
 * 辅助函数：根据文件 Uri 和目标行号查找所有对应书签 (多书签场景)
 */
function findBookmarksAtPosition(
  storage: StorageManager,
  docUri: vscode.Uri,
  line: number
): IBookmark[] {
  const relPath = storage.normalizeRelativePath(docUri);
  return storage.getBookmarks().filter((b) => {
    if (b.line !== line) {
      return false;
    }
    if (b.filePath === relPath) {
      return true;
    }
    const bUri = storage.resolveFileUri(b.filePath);
    return bUri?.fsPath === docUri.fsPath;
  });
}

/**
 * 辅助函数：获取分组展示名称 (统一处理国际化默认分组)
 */
function getGroupDisplayName(group?: { id: string; name: string }): string {
  if (!group) {
    return '';
  }
  return group.id === DEFAULT_GROUP_ID && group.name === '默认分组'
    ? vscode.l10n.t('Default Group')
    : group.name;
}

/**
 * 辅助函数：提取右键命令传参或活动编辑器的光标位置
 */
function getContextTarget(arg?: any): { uri?: vscode.Uri; line?: number } {
  if (arg && typeof arg.lineNumber === 'number' && arg.uri instanceof vscode.Uri) {
    return { uri: arg.uri, line: arg.lineNumber };
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return { uri: editor.document.uri, line: editor.selection.active.line + 1 };
  }
  return {};
}

/**
 * 《核心位置》：动态维护当前编辑器在行号区的书签行号集合 (xmark.bookmarkedLines)
 * 逻辑解释：
 * 1. 提取当前文件在书签存储中的所有行号数组 bookmarkedLines，更新 xmark.bookmarkedLines 上下文。
 * 2. 配合 VS Code 原生的 'editorLineNumber in xmark.bookmarkedLines'，实现行号区右键零延迟精准判断。
 * 3. 彻底解耦光标选区，光标在任何位置都不会影响行号右键判定。
 * 隐患点：无活动编辑器或文件非 file 协议时，必须清空上下文键，避免跨文件状态污染。
 */
function updateEditorBookmarkedLines(
  editor: vscode.TextEditor | undefined,
  storage: StorageManager
): void {
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.commands.executeCommand('setContext', 'xmark.bookmarkedLines', []);
    return;
  }
  const bookmarkedLines = storage.getBookmarkedLinesForUri(editor.document.uri);
  vscode.commands.executeCommand('setContext', 'xmark.bookmarkedLines', bookmarkedLines);
}

/*
 * 《核心位置》：用户交互与快捷命令统一调度注册 (已接入 VS Code 原生 i18n 国际化)
 * 逻辑解释：
 * 1. 专一聚焦行号区右键与侧边栏树节点，完全移除有跨进程时序缺陷的代码区右键。
 * 2. 行号区右键借助原生 editorLineNumber 实现零延迟互斥（无书签显示添加，有书签显示重命名与删除）。
 * 3. 串联极速单弹窗添加书签，回车秒级入库，支持右上角切换分组。
 * 4. 所有交互提示、选项文本均通过 vscode.l10n.t(...) 实现多语言动态适配。
 * 隐患点：无活动编辑器或行号异常时，需优雅弹窗提示而非抛出未捕获错误。
 */
export function registerBookmarkCommands(
  context: vscode.ExtensionContext,
  storage: StorageManager,
  git: GitService
): void {
  // 监听编辑器切换、文档编辑及存储变动，即时刷新行号集合
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateEditorBookmarkedLines(editor, storage);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.fsPath === e.document.uri.fsPath) {
        updateEditorBookmarkedLines(activeEditor, storage);
      }
    }),
    storage.onDidChangeData(() => {
      updateEditorBookmarkedLines(vscode.window.activeTextEditor, storage);
    })
  );

  // 初始化设置一次
  updateEditorBookmarkedLines(vscode.window.activeTextEditor, storage);

  // 1. 添加书签命令 (行号区右键与命令面板调用)
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.addBookmark', async (arg?: any) => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('No workspace folder is open. Please open a folder first.')
        );
        return;
      }

      let targetUri: vscode.Uri | undefined;
      let targetLine: number | undefined;

      // 提取行号区上下文参数
      if (arg && typeof arg.lineNumber === 'number' && arg.uri instanceof vscode.Uri) {
        targetUri = arg.uri;
        targetLine = arg.lineNumber;
      } else {
        // 从当前活动编辑器光标提取
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('Please open a code file first to add a bookmark')
          );
          return;
        }
        targetUri = editor.document.uri;
        targetLine = editor.selection.active.line + 1;
      }

      if (!targetUri || !targetLine) {
        return;
      }

      /*
       * 《核心位置》：极速单弹窗添加书签交互 (放开单行多书签限制，同组排重)
       * 逻辑解释：
       * 1. 解除单行仅限一个书签的限制，允许同一行代码根据不同业务意图归属到不同分组中。
       * 2. 预选分组策略：无论当前行是否已有书签，默认目标分组与组选择弹窗均统一稳定预选系统默认分组 (defaultGroupId)，杜绝非预期跳组。
       * 3. 切换分组列表直观提示已打书签状态：分组列表中对当前行已存在书签的分组打上标示 (当前行已有书签)。
       * 4. 同组排重保护：若在同一行、同一分组下重复添加，弹窗警告并保持输入框不销毁，防止误操作或覆盖。
       * 5. 回车秒级入库：预填当前行代码摘要，一键回车即可入库。
       * 隐患点：点击切换分组取消或同组排重拦截时，需恢复主输入框显示并保持状态，避免用户输入丢失。
       */
      const existingBookmarks = findBookmarksAtPosition(storage, targetUri, targetLine);
      const existingGroupIds = new Set(existingBookmarks.map((b) => b.groupId));

      const defaultGroupId = storage.getDefaultGroupId();
      const allGroups = storage.getGroups();

      // 无论当前代码行是否已存在书签，输入框与分组弹窗均始终预选系统默认组
      let currentGroup: IBookmarkGroup =
        allGroups.find((g) => g.id === defaultGroupId) || allGroups[0];

      const relPath = storage.normalizeRelativePath(targetUri);
      const lineContent = await getLineContent(relPath, targetLine, targetUri);
      const defaultName = lineContent.trim().slice(0, 40) || `${relPath}:${targetLine}`;

      const inputBox = vscode.window.createInputBox();
      inputBox.title = vscode.l10n.t('Add Bookmark to [{0}]', getGroupDisplayName(currentGroup));
      inputBox.placeholder = vscode.l10n.t('Enter bookmark name');
      inputBox.prompt = vscode.l10n.t(
        'Press Enter to confirm, or click top-right folder icon to change group'
      );
      inputBox.value = defaultName;
      inputBox.valueSelection = [0, defaultName.length];

      const changeGroupButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('folder'),
        tooltip: vscode.l10n.t('Change Bookmark Group')
      };
      inputBox.buttons = [changeGroupButton];

      let isSubDialogOpen = false;

      // 点击右上角按钮切换分组
      inputBox.onDidTriggerButton(async () => {
        isSubDialogOpen = true;
        try {
          const groups = storage.getGroups();
          const otherGroups = groups.filter((g) => g.id !== currentGroup.id);
          const sortedGroups = [currentGroup, ...otherGroups];
          const createLabel = `$(add) ${vscode.l10n.t('+ New Group...')}`;

          const pickItems: (vscode.QuickPickItem & { groupObject?: any })[] = [
            ...sortedGroups.map((g) => {
              const isCurrent = g.id === currentGroup.id;
              const hasBookmark = existingGroupIds.has(g.id);
              const descParts: string[] = [];
              if (isCurrent) {
                descParts.push(vscode.l10n.t('(Current)'));
              }
              if (hasBookmark) {
                descParts.push(vscode.l10n.t('(Has bookmark on this line)'));
              }

              const displayName = getGroupDisplayName(g);
              return {
                label: isCurrent ? `$(star-full) ${displayName}` : `$(folder) ${displayName}`,
                description: descParts.length > 0 ? descParts.join(' ') : undefined,
                groupObject: g
              };
            }),
            { label: createLabel, description: vscode.l10n.t('Create a new bookmark group') }
          ];

          const selected = await vscode.window.showQuickPick(pickItems, {
            placeHolder: vscode.l10n.t('Select a bookmark group')
          });

          if (selected) {
            if (selected.label === createLabel) {
              const newGroupName = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Enter new group name'),
                placeHolder: vscode.l10n.t('e.g., Auth Flow, Database')
              });
              if (newGroupName?.trim()) {
                const created = await storage.addGroup(newGroupName.trim());
                currentGroup = created;
              }
            } else if ((selected as any).groupObject) {
              currentGroup = (selected as any).groupObject;
            }

            inputBox.title = vscode.l10n.t('Add Bookmark to [{0}]', getGroupDisplayName(currentGroup));
          }
        } finally {
          isSubDialogOpen = false;
          inputBox.show();
        }
      });

      // 回车直接完成添加
      inputBox.onDidAccept(async () => {
        // 同组排重校验：同一行在同一分组内禁止重复添加
        const duplicate = existingBookmarks.find((b) => b.groupId === currentGroup.id);
        if (duplicate) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Group [{0}] already has a bookmark on this line: [{1}]',
              getGroupDisplayName(currentGroup),
              duplicate.name
            )
          );
          inputBox.show();
          return;
        }

        const finalName = inputBox.value.trim() || defaultName;
        inputBox.dispose();

        const currentCommit = await git.getHeadCommit(targetUri);
        const lineHash = computeLineHash(lineContent);

        await storage.addBookmark({
          filePath: relPath,
          line: targetLine,
          name: finalName,
          groupId: currentGroup.id,
          commit: currentCommit,
          lineHash
        });

        vscode.window.setStatusBarMessage(
          vscode.l10n.t('XMark: Bookmark added to [{0}]', finalName),
          3000
        );
      });

      // 仅当非子弹窗引起的隐藏（如用户按 ESC 取消）时才销毁
      inputBox.onDidHide(() => {
        if (!isSubDialogOpen) {
          inputBox.dispose();
        }
      });

      inputBox.show();
    })
  );

  // 2. 刷新视图命令
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.refreshView', () => {
      storage.loadFromDisk();
      vscode.window.setStatusBarMessage(
        vscode.l10n.t('XMark: Bookmark data resynchronized'),
        2000
      );
    })
  );

  // 3. 新建分组命令
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.addGroup', async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('No workspace folder is open. Please open a folder first.')
        );
        return;
      }

      const groupName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Enter new group name'),
        placeHolder: vscode.l10n.t('e.g., Auth Flow, Database')
      });
      if (groupName?.trim()) {
        await storage.addGroup(groupName.trim());
      }
    })
  );

  // 4. 重命名分组
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.renameGroup', async (item?: GroupTreeItem) => {
      if (!item) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Rename Group'),
        value: item.group.name
      });
      if (newName?.trim() && newName.trim() !== item.group.name) {
        storage.renameGroup(item.group.id, newName.trim());
      }
    })
  );

  // 5. 设置默认分组
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.setDefaultGroup', (item?: GroupTreeItem) => {
      if (!item) {
        return;
      }
      storage.setDefaultGroupId(item.group.id);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t('Default group set to [{0}]', item.group.name),
        2500
      );
    })
  );

  // 6. 删除分组 (带保护确认选项)
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.deleteGroup', async (item?: GroupTreeItem) => {
      if (!item) {
        return;
      }
      if (item.group.id === DEFAULT_GROUP_ID || item.group.id === storage.getDefaultGroupId()) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Default group is protected and cannot be deleted')
        );
        return;
      }

      const bookmarks = storage.getBookmarks(item.group.id);
      if (bookmarks.length > 0) {
        const moveToDefaultLabel = vscode.l10n.t('Move to Default Group');
        const deleteAllLabel = vscode.l10n.t('Delete All');

        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Group [{0}] contains {1} bookmark(s). Please choose how to proceed:',
            item.group.name,
            bookmarks.length
          ),
          { modal: true },
          moveToDefaultLabel,
          deleteAllLabel
        );

        if (choice === moveToDefaultLabel) {
          storage.deleteGroup(item.group.id, true);
        } else if (choice === deleteAllLabel) {
          storage.deleteGroup(item.group.id, false);
        }
      } else {
        storage.deleteGroup(item.group.id, false);
      }
    })
  );

  /**
   * 《核心位置》：重命名书签命令 (同时支持侧边栏节点与行号区多书签选择)
   * 逻辑解释：
   * 1. 侧边栏节点触发：精准定位目标节点，直接弹出重命名输入框。
   * 2. 行号区触发：
   *    - 若当前行仅有 1 个书签：直接弹出输入框修改，极速体验。
   *    - 若当前行有 >=2 个书签 (单行多书签)：弹出 QuickPick 微型面板展示书签名与所属分组，供精准选择要重命名的书签。
   * 隐患点：无活动编辑器或行号异常时，需优雅静默退出，避免未捕获异常。
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.renameBookmark', async (arg?: any) => {
      let targetBookmark: IBookmark | undefined;

      if (arg instanceof BookmarkTreeItem) {
        targetBookmark = arg.bookmark;
      } else {
        const { uri, line } = getContextTarget(arg);
        if (uri && line) {
          const bookmarks = findBookmarksAtPosition(storage, uri, line);
          if (bookmarks.length === 1) {
            targetBookmark = bookmarks[0];
          } else if (bookmarks.length > 1) {
            const pickItems = bookmarks.map((bm) => {
              const group = storage.getGroups().find((g) => g.id === bm.groupId);
              const groupName = getGroupDisplayName(group) || bm.groupId;
              return {
                label: `$(bookmark) ${bm.name}`,
                description: `[${groupName}]`,
                bookmark: bm
              };
            });

            const selected = await vscode.window.showQuickPick(pickItems, {
              placeHolder: vscode.l10n.t('Multiple bookmarks on this line. Select one to rename:'),
              title: vscode.l10n.t('Rename Bookmark (Line {0})', line)
            });

            if (!selected) {
              return;
            }
            targetBookmark = selected.bookmark;
          }
        }
      }

      if (!targetBookmark) {
        return;
      }

      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Rename Bookmark'),
        value: targetBookmark.name,
        valueSelection: [0, targetBookmark.name.length]
      });
      if (newName?.trim()) {
        storage.updateBookmark(targetBookmark.id, { name: newName.trim() });
      }
    })
  );

  /**
   * 《核心位置》：删除书签命令 (同时支持侧边栏节点与行号区多书签选择/批量删除)
   * 逻辑解释：
   * 1. 侧边栏节点触发：精准定位目标节点，直接执行删除。
   * 2. 行号区触发：
   *    - 若当前行仅有 1 个书签：直接删除，即刻生效。
   *    - 若当前行有 >=2 个书签：弹出列表供选择删除单个书签，或选择“全部删除此行的书签”一键清空。
   * 隐患点：删除完成后需确保 Gutter 装饰与树视图同步刷新。
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.deleteBookmark', async (arg?: any) => {
      if (arg instanceof BookmarkTreeItem) {
        storage.deleteBookmark(arg.bookmark.id);
        vscode.window.setStatusBarMessage(
          `$(trash) ${vscode.l10n.t('XMark: Bookmark deleted')}`,
          2000
        );
        return;
      }

      const { uri, line } = getContextTarget(arg);
      if (!uri || !line) {
        return;
      }

      const bookmarks = findBookmarksAtPosition(storage, uri, line);
      if (bookmarks.length === 0) {
        return;
      }

      if (bookmarks.length === 1) {
        storage.deleteBookmark(bookmarks[0].id);
        vscode.window.setStatusBarMessage(
          `$(trash) ${vscode.l10n.t('XMark: Bookmark deleted')}`,
          2000
        );
        return;
      }

      const deleteAllLabel = `$(trash) ${vscode.l10n.t('Delete All on This Line')}`;
      const pickItems: (vscode.QuickPickItem & { bookmarkId?: string; isDeleteAll?: boolean })[] = [
        ...bookmarks.map((bm) => {
          const group = storage.getGroups().find((g) => g.id === bm.groupId);
          const groupName = getGroupDisplayName(group) || bm.groupId;
          return {
            label: `$(bookmark) ${bm.name}`,
            description: `[${groupName}]`,
            bookmarkId: bm.id
          };
        }),
        {
          label: deleteAllLabel,
          description: vscode.l10n.t('{0} bookmark(s)', bookmarks.length),
          isDeleteAll: true
        }
      ];

      const selected = await vscode.window.showQuickPick(pickItems, {
        placeHolder: vscode.l10n.t('Multiple bookmarks on this line. Select one to delete:'),
        title: vscode.l10n.t('Delete Bookmark (Line {0})', line)
      });

      if (!selected) {
        return;
      }

      if (selected.isDeleteAll) {
        bookmarks.forEach((bm) => storage.deleteBookmark(bm.id));
        vscode.window.setStatusBarMessage(
          `$(trash) ${vscode.l10n.t('XMark: {0} bookmark(s) deleted', bookmarks.length)}`,
          2000
        );
      } else if (selected.bookmarkId) {
        storage.deleteBookmark(selected.bookmarkId);
        vscode.window.setStatusBarMessage(
          `$(trash) ${vscode.l10n.t('XMark: Bookmark deleted')}`,
          2000
        );
      }
    })
  );

  // 8. 更新书签状态为当前行代码内容 (针对内容变动书签)
  context.subscriptions.push(
    vscode.commands.registerCommand('xmark.updateBookmarkToCurrent', async (item?: BookmarkTreeItem) => {
      if (!item) {
        return;
      }
      const bm = item.bookmark;
      const fileUri = storage.resolveFileUri(bm.filePath);
      const currentCommit = await git.getHeadCommit(fileUri);
      const currentLineText = await getLineContent(bm.filePath, bm.line, fileUri);
      const newHash = computeLineHash(currentLineText);

      storage.updateBookmark(bm.id, {
        commit: currentCommit,
        lineHash: newHash
      });

      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Bookmark [{0}] has been synchronized with the current line content',
          bm.name
        )
      );
    })
  );
}
