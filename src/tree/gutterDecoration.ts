import * as vscode from 'vscode';
import { StorageManager } from '../services/storageManager.js';
import { GitService } from '../services/gitService.js';
import { checkBookmarkDrift } from '../services/driftChecker.js';
import { DEFAULT_GROUP_ID, IBookmark } from '../types.js';

/*
 * 《核心位置》：编辑器行号区域 (Gutter) 图标装饰器 (已接入 VS Code 原生 i18n 国际化)
 * 逻辑解释：
 * 1. 初始化四套独立的 TextEditorDecorationType：
 *    - 单书签正常 (bookmark.svg)
 *    - 单书签告警 (bookmark-warning.svg)
 *    - 多书签正常 (bookmark-multiple.svg，具备层叠视觉与主题透明间隙)
 *    - 多书签告警 (bookmark-multiple-warning.svg)
 * 2. 匹配当前可见编辑器的活动文件，按行号聚合书签并并行检测变动 (Drift)。
 * 3. 单书签行展示标准书签图标；多书签行展示层叠双书签图标，直观区分。
 * 4. 悬浮提示 (Hover) 智能适配：单书签显示详情，多书签聚合列出当前行所有书签、归属分组及各自变动状态。
 * 隐患点：
 * 1. bookmark.line 是 1-based，而 VS Code 内部 Range 是 0-based，必须使用 Math.max(0, bm.line - 1)。
 * 2. 必须处理文件行数被削减时越界的边界问题。
 */
export class GutterDecorationManager implements vscode.Disposable {
  private normalDecorationType: vscode.TextEditorDecorationType;
  private warningDecorationType: vscode.TextEditorDecorationType;
  private normalMultipleDecorationType: vscode.TextEditorDecorationType;
  private warningMultipleDecorationType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private extensionContext: vscode.ExtensionContext,
    private storage: StorageManager,
    private git: GitService
  ) {
    this.normalDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'bookmark.svg'),
      gutterIconSize: 'contain'
    });

    this.warningDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'bookmark-warning.svg'),
      gutterIconSize: 'contain'
    });

    this.normalMultipleDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'bookmark-multiple.svg'),
      gutterIconSize: 'contain'
    });

    this.warningMultipleDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'bookmark-multiple-warning.svg'),
      gutterIconSize: 'contain'
    });

    // 监听视图切换与文件变动事件
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateEditorDecorations(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach((editor) => this.updateEditorDecorations(editor));
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === doc.uri.toString()
        );
        if (editor) {
          this.updateEditorDecorations(editor);
        }
      }),
      this.storage.onDidChangeData(() => {
        this.updateAllVisibleEditors();
      }),
      this.git.onDidChange(() => {
        this.updateAllVisibleEditors();
      })
    );

    // 初始执行一次全局装饰更新
    this.updateAllVisibleEditors();
  }

  public updateAllVisibleEditors(): void {
    vscode.window.visibleTextEditors.forEach((editor) => {
      this.updateEditorDecorations(editor);
    });
  }

  public async updateEditorDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!editor || !editor.document) {
      return;
    }

    const docUri = editor.document.uri;
    if (docUri.scheme !== 'file') {
      return;
    }

    const relPath = this.storage.normalizeRelativePath(docUri);
    const bookmarks = this.storage.getBookmarks().filter((b) => b.filePath === relPath);

    if (bookmarks.length === 0) {
      editor.setDecorations(this.normalDecorationType, []);
      editor.setDecorations(this.warningDecorationType, []);
      editor.setDecorations(this.normalMultipleDecorationType, []);
      editor.setDecorations(this.warningMultipleDecorationType, []);
      return;
    }

    const currentHeadCommit = await this.git.getHeadCommit(docUri);
    const normalDecorations: vscode.DecorationOptions[] = [];
    const warningDecorations: vscode.DecorationOptions[] = [];
    const normalMultipleDecorations: vscode.DecorationOptions[] = [];
    const warningMultipleDecorations: vscode.DecorationOptions[] = [];

    // 按行号聚合当前文件的所有书签
    const lineMap = new Map<number, IBookmark[]>();
    for (const bm of bookmarks) {
      const line = bm.line;
      const list = lineMap.get(line) || [];
      list.push(bm);
      lineMap.set(line, list);
    }

    const groups = this.storage.getGroups();
    const getGroupName = (groupId: string) => {
      const g = groups.find((group) => group.id === groupId);
      return g?.id === DEFAULT_GROUP_ID && g?.name === '默认分组'
        ? vscode.l10n.t('Default Group')
        : (g?.name || groupId);
    };

    for (const [line, lineBookmarks] of lineMap) {
      const lineIndex = line - 1;
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
        continue;
      }

      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);

      // 并行检测当前行所有书签的变动状态
      const driftResults = await Promise.all(
        lineBookmarks.map(async (bm) => {
          const drift = await checkBookmarkDrift(bm, currentHeadCommit, docUri);
          return { bm, drift };
        })
      );

      const hasAnyDrift = driftResults.some((item) => item.drift.hasChanged);

      if (lineBookmarks.length === 1) {
        // 单书签模式：使用标准书签或标准告警图标
        const { bm, drift } = driftResults[0];
        if (drift.hasChanged) {
          const reason: string[] = [];
          if (drift.commitChanged) {
            reason.push(
              `- ${vscode.l10n.t(
                'Git commit changed (Recorded: `{0}` -> Current: `{1}`)',
                bm.commit.slice(0, 7) || 'none',
                currentHeadCommit.slice(0, 7) || 'none'
              )}`
            );
          }
          if (drift.contentChanged) {
            reason.push(`- ${vscode.l10n.t('Code content hash mismatch')}`);
          }

          const md = new vscode.MarkdownString(
            `⚠️ **${vscode.l10n.t(
              'XMark Bookmark: {0} [Code may have changed]',
              bm.name
            )}**\n\n${reason.join('\n')}\n\n*${vscode.l10n.t(
              'Clicking bookmark still jumps to line {0}',
              bm.line
            )}*`
          );
          warningDecorations.push({ range, hoverMessage: md });
        } else {
          const groupName = getGroupName(bm.groupId);
          const md = new vscode.MarkdownString(
            `🔖 **${vscode.l10n.t('XMark Bookmark: {0}', bm.name)}**\n\n- ${vscode.l10n.t(
              'File: `{0}`',
              bm.filePath
            )}\n- ${vscode.l10n.t('Line: Line {0}', bm.line)}\n- [${groupName}]`
          );
          normalDecorations.push({ range, hoverMessage: md });
        }
      } else {
        // 多书签模式：使用层叠多书签图标，并在 Hover 提示中展示全部书签与分组
        const title = hasAnyDrift
          ? vscode.l10n.t('XMark: {0} bookmarks on Line {1} [Some code may have changed]', lineBookmarks.length, line)
          : vscode.l10n.t('XMark: {0} bookmarks on Line {1}', lineBookmarks.length, line);

        const listLines = driftResults.map(({ bm, drift }) => {
          const groupLabel = `\`[${getGroupName(bm.groupId)}]\``;
          if (drift.hasChanged) {
            return `- 🔖 **${bm.name}** ${groupLabel} ⚠️ *(${vscode.l10n.t('Code may have changed')})*`;
          }
          return `- 🔖 **${bm.name}** ${groupLabel}`;
        });

        const footer = `\n\n*${vscode.l10n.t('Right-click line number to manage or add bookmarks')}*`;
        const md = new vscode.MarkdownString(`${hasAnyDrift ? '⚠️' : '🔖'} **${title}**\n\n${listLines.join('\n')}${footer}`);

        if (hasAnyDrift) {
          warningMultipleDecorations.push({ range, hoverMessage: md });
        } else {
          normalMultipleDecorations.push({ range, hoverMessage: md });
        }
      }
    }

    editor.setDecorations(this.normalDecorationType, normalDecorations);
    editor.setDecorations(this.warningDecorationType, warningDecorations);
    editor.setDecorations(this.normalMultipleDecorationType, normalMultipleDecorations);
    editor.setDecorations(this.warningMultipleDecorationType, warningMultipleDecorations);
  }

  public dispose(): void {
    this.normalDecorationType.dispose();
    this.warningDecorationType.dispose();
    this.normalMultipleDecorationType.dispose();
    this.warningMultipleDecorationType.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
