import * as vscode from 'vscode';
import { getHeadCommit as getHeadCommitByCli } from '../core/gitHelper.js';

/*
 * 《核心位置》：Git 状态检测与提交信息获取 (多根工作区与子仓库精准实时适配)
 * 逻辑解释：
 * 1. 摒弃容易受多根扫描深度、盘符大小写及异步刷新延迟影响的 VS Code 内置 Git API 状态读取与内存缓存。
 * 2. 统一直接复用 gitHelper.getHeadCommit(targetUri.fsPath)，在目标文件真实所在目录实时执行 git rev-parse HEAD，100% 精准匹配多根工作区、嵌套子仓库及外部文件。
 * 3. 保留 vscode.git 扩展状态监听，仅用于在仓库变化时通知 TreeView 与行号装饰器触发界面刷新。
 * 隐患点：每次添加或更新书签时会拉起一次轻量 git CLI 进程 (2000ms 超时保护)，高频批量操作不建议在循环中直接串行调用。
 */
export class GitService implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.initGitExtensionWatcher();
  }

  private async initGitExtensionWatcher(): Promise<void> {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (gitExt) {
        if (!gitExt.isActive) {
          await gitExt.activate();
        }
        const gitApi = gitExt.exports?.getAPI?.(1);
        if (gitApi) {
          this.disposables.push(
            gitApi.onDidOpenRepository((repo: any) => {
              this._onDidChange.fire();
              this.disposables.push(
                repo.state.onDidChange(() => {
                  this._onDidChange.fire();
                })
              );
            })
          );

          for (const repo of gitApi.repositories) {
            this.disposables.push(
              repo.state.onDidChange(() => {
                this._onDidChange.fire();
              })
            );
          }
        }
      }
    } catch (error) {
      console.warn('[XMark] 初始化 VS Code Git 扩展监听失败，不影响 Commit 实时获取:', error);
    }
  }

  public async getHeadCommit(baseUri?: vscode.Uri): Promise<string> {
    const targetUri = baseUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!targetUri || targetUri.scheme !== 'file') {
      return '';
    }

    return getHeadCommitByCli(targetUri.fsPath);
  }

  public dispose(): void {
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
