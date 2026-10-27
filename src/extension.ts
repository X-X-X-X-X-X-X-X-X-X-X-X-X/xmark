import * as vscode from 'vscode';
import { StorageManager } from './services/storageManager.js';
import { GitService } from './services/gitService.js';
import { GutterDecorationManager } from './tree/gutterDecoration.js';
import { BookmarkTreeProvider } from './tree/bookmarkTreeProvider.js';
import { BookmarkDndController } from './tree/bookmarkDndController.js';
import { registerBookmarkCommands } from './commands/registerCommands.js';

/*
 * 《核心位置》：VS Code 扩展激活主入口
 * 逻辑解释：
 * 1. 组装存储服务 (StorageManager)、Git 检测服务 (GitService)。
 * 2. 挂载编辑器行号区装饰器 (GutterDecorationManager)。
 * 3. 构造侧边栏树视图及拖拽控制器 (TreeDragAndDropController)。
 * 4. 注册所有右键菜单与面板操作命令。
 * 隐患点：工作区变更或插件卸载时需依次调用各服务的 dispose 方法，防止内存泄漏。
 */
export function activate(context: vscode.ExtensionContext): void {
  const storage = new StorageManager();
  const git = new GitService();
  const gutter = new GutterDecorationManager(context, storage, git);

  const treeProvider = new BookmarkTreeProvider(context.extensionUri, storage, git);
  const dndController = new BookmarkDndController(storage);

  const treeView = vscode.window.createTreeView('xmarkBookmarkView', {
    treeDataProvider: treeProvider,
    dragAndDropController: dndController,
    showCollapseAll: true
  });

  registerBookmarkCommands(context, storage, git);

  context.subscriptions.push(
    storage,
    git,
    gutter,
    treeProvider,
    treeView
  );

  console.log('[XMark] 代码书签插件已成功激活。');
}

export function deactivate(): void {
  // 资源由 VS Code context.subscriptions 统一回收
}

