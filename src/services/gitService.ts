import * as child_process from 'node:child_process';
import * as util from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = util.promisify(child_process.execFile);

/*
 * 《核心位置》：Git 状态检测与提交信息获取 (多工作区细粒度适配)
 * 逻辑解释：
 * 1. 采用 Map 缓存每个子工作区/子仓库的 HEAD Commit，多仓库互不干扰。
 * 2. 优先调用 VS Code 内置 git 扩展 API 获取目标文件的仓库实例。
 * 3. 降级使用 git CLI 时，将 cwd 锁定在目标文件所在的子工作区根目录。
 * 隐患点：某个子目录未初始化 Git 时，需捕获异常并返回空串，不影响其他子工程正常使用。
 */
export class GitService implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];
  private commitCache = new Map<string, string>();

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
              this.disposables.push(
                repo.state.onDidChange(() => {
                  this.invalidateCache();
                  this._onDidChange.fire();
                })
              );
            })
          );

          for (const repo of gitApi.repositories) {
            this.disposables.push(
              repo.state.onDidChange(() => {
                this.invalidateCache();
                this._onDidChange.fire();
              })
            );
          }
        }
      }
    } catch (error) {
      console.warn('[XMark] 初始化 VS Code Git 扩展监听失败，将降级使用 CLI 比对:', error);
    }
  }

  public invalidateCache(): void {
    this.commitCache.clear();
  }

  public async getHeadCommit(baseUri?: vscode.Uri): Promise<string> {
    const targetFolder = baseUri
      ? vscode.workspace.getWorkspaceFolder(baseUri)?.uri ?? baseUri
      : vscode.workspace.workspaceFolders?.[0]?.uri;

    if (!targetFolder) {
      return '';
    }

    const cacheKey = targetFolder.fsPath;
    if (this.commitCache.has(cacheKey)) {
      return this.commitCache.get(cacheKey)!;
    }

    // 1. 优先尝试 VS Code 内置 Git 扩展
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (gitExt?.isActive) {
        const gitApi = gitExt.exports?.getAPI?.(1);
        const repo = gitApi?.getRepository(targetFolder);
        const commit = repo?.state?.HEAD?.commit;
        if (commit) {
          this.commitCache.set(cacheKey, commit);
          return commit;
        }
      }
    } catch {
      // 忽略内置扩展获取错误，进入 CLI 尝试
    }

    // 2. 降级使用 git CLI
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: targetFolder.fsPath,
        timeout: 2000
      });
      const commit = stdout.trim();
      this.commitCache.set(cacheKey, commit);
      return commit;
    } catch {
      return '';
    }
  }

  public dispose(): void {
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
