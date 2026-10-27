import * as vscode from 'vscode';
import { IBookmark, IBookmarkGroup, IDriftStatus } from '../types.js';

/**
 * 《核心位置》：侧边栏分组树节点
 * 逻辑解释：
 * 1. 默认分组初始化进入时保持展开 (TreeItemCollapsibleState.Expanded)，其他分组保持折叠 (Collapsed)，保持列表清爽。
 * 2. 默认分组采用 VS Code 原生设计风格：图标使用金色星标 (charts.yellow)，与 QuickPick 选择面板保持统一。
 * 3. 节点描述统一为纯净的数量标示 (count)，去除冗余粗糙的文字标签，保持界面视觉清爽。
 * 4. 悬浮提示 (Tooltip) 中明确指出默认分组状态，兼顾美观与信息传达。
 * 隐患点：若用户自定义分组名称包含国际化保留词，需确保显示名称与原始 group.name 解耦。
 */
export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly group: IBookmarkGroup,
    public readonly count: number,
    public readonly isDefault: boolean = false
  ) {
    const displayName = group.id === 'default' && group.name === '默认分组'
      ? vscode.l10n.t('Default Group')
      : group.name;

    const collapsibleState = isDefault
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;

    super(displayName, collapsibleState);
    this.id = `group_${group.id}`;
    this.contextValue = isDefault ? 'group:default' : 'group';
    this.description = `(${count})`;
    this.tooltip = isDefault
      ? `${displayName} (${vscode.l10n.t('Default Group')})`
      : displayName;
    this.iconPath = isDefault
      ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('folder');
  }
}

/**
 * 侧边栏书签树节点
 */
export class BookmarkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly bookmark: IBookmark,
    public readonly drift: IDriftStatus,
    resourceUri?: vscode.Uri,
    extensionUri?: vscode.Uri
  ) {
    super(bookmark.name, vscode.TreeItemCollapsibleState.None);
    this.id = `bm_${bookmark.id}`;

    if (resourceUri) {
      this.resourceUri = resourceUri;
    }

    if (drift.hasChanged) {
      this.contextValue = 'bookmark:drifted';
      this.iconPath = extensionUri
        ? vscode.Uri.joinPath(extensionUri, 'resources', 'bookmark-warning.svg')
        : new vscode.ThemeIcon(
            'diff-modified',
            new vscode.ThemeColor('editorWarning.foreground')
          );
      this.description = `${bookmark.filePath}:${bookmark.line} ${vscode.l10n.t('[Changed]')}`;

      const reasons: string[] = [];
      if (drift.commitChanged) {
        reasons.push(
          `- ${vscode.l10n.t(
            'Git commit changed (Recorded: `{0}` -> Current: `{1}`)',
            bookmark.commit.slice(0, 7) || 'none',
            drift.currentCommit.slice(0, 7) || 'none'
          )}`
        );
      }
      if (drift.contentChanged) {
        reasons.push(`- ${vscode.l10n.t('Code content hash mismatch')}`);
      }
      this.tooltip = new vscode.MarkdownString(
        `⚠️ **${vscode.l10n.t('Code may have changed')}**\n\n${reasons.join('\n')}\n\n*${vscode.l10n.t(
          'File: {0} (Line {1})',
          bookmark.filePath,
          bookmark.line
        )}*`
      );
    } else {
      this.contextValue = 'bookmark';
      this.iconPath = extensionUri
        ? vscode.Uri.joinPath(extensionUri, 'resources', 'bookmark.svg')
        : new vscode.ThemeIcon('bookmark');
      this.description = `${bookmark.filePath}:${bookmark.line}`;
      this.tooltip = `${bookmark.name}\n${vscode.l10n.t(
        'File: {0} (Line {1})',
        bookmark.filePath,
        bookmark.line
      )}`;
    }

    // 点击直接跳转至指定行
    this.command = {
      command: 'vscode.open',
      title: vscode.l10n.t('Jump to Code Line'),
      arguments: [
        resourceUri,
        {
          selection: new vscode.Range(
            Math.max(0, bookmark.line - 1),
            0,
            Math.max(0, bookmark.line - 1),
            0
          ),
          preview: true
        }
      ]
    };
  }
}

export type XMarkTreeItem = GroupTreeItem | BookmarkTreeItem;
