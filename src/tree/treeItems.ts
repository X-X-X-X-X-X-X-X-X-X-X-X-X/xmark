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

    /*
     * 《核心位置》：侧边栏书签项 Tooltip 交互式悬浮提示构造
     * 逻辑解释：
     * 1. 采用 MarkdownString 呈现富文本，开启 isTrusted 与 supportThemeIcons。
     * 2. 包含 [$(copy)](command:xmark.copyCommit?...) 交互式命令链接，VS Code 会将其提升为交互式浮层，鼠标移向浮层时不会消失，且支持一键复制。
     * 3. 当存在 commit 记录时展示 40 位完整 Commit Hash，无记录时不展示。
     * 隐患点：Markdown 参数需要通过 JSON.stringify 和 encodeURIComponent 转义，确保参数被 VS Code 命令路由正确反序列化。
     */
    let commitSection = '';
    if (bookmark.commit) {
      const copyArgs = encodeURIComponent(JSON.stringify([bookmark.commit]));
      const copyBtn = `[$(copy)](command:xmark.copyCommit?${copyArgs} "${vscode.l10n.t('Copy Commit Hash')}")`;
      commitSection = `\n- Commit: \`${bookmark.commit}\` ${copyBtn}`;
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

      const reason = `- ${vscode.l10n.t('Code content hash mismatch')}`;
      const md = new vscode.MarkdownString(
        `⚠️ **${vscode.l10n.t('Code may have changed')}**\n\n${reason}\n- ${vscode.l10n.t(
          'File: {0} (Line {1})',
          bookmark.filePath,
          bookmark.line
        )}${commitSection}`
      );
      md.isTrusted = true;
      md.supportThemeIcons = true;
      this.tooltip = md;
    } else {
      this.contextValue = 'bookmark';
      this.iconPath = extensionUri
        ? vscode.Uri.joinPath(extensionUri, 'resources', 'bookmark.svg')
        : new vscode.ThemeIcon('bookmark');
      this.description = `${bookmark.filePath}:${bookmark.line}`;
      const md = new vscode.MarkdownString(
        `🔖 **${bookmark.name}**\n\n- ${vscode.l10n.t(
          'File: {0} (Line {1})',
          bookmark.filePath,
          bookmark.line
        )}${commitSection}`
      );
      md.isTrusted = true;
      md.supportThemeIcons = true;
      this.tooltip = md;
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
