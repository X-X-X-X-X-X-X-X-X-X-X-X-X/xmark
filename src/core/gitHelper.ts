import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';

const execFileAsync = util.promisify(child_process.execFile);

/**
 * 解析目标路径对应的有效工作目录 (兼容传入文件路径、目录路径或尚未落盘的路径)
 */
export function resolveGitWorkingDirectory(targetPath: string): string | undefined {
  if (!targetPath) {
    return undefined;
  }
  let current = path.resolve(targetPath);

  while (true) {
    try {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        return current;
      }
      // 如果是文件路径，直接返回其所在目录
      return path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

/**
 * 《核心位置》：无宿主依赖的轻量 Git Commit Hash 获取器 (精准定位目标文件所属 Git 仓库)
 * 逻辑解释：
 * 1. 先通过 resolveGitWorkingDirectory 将文件或目录路径安全转为存在的目录 cwd，防止传文件路径触发 ENOTDIR。
 * 2. 在该文件所在真实目录下调用 git rev-parse HEAD，自动匹配其所属的最内层 Git 仓库 (支持多根工作区与嵌套子仓库)。
 * 3. 设置 2000ms 超时限制，避免外部 git 进程挂起或等待凭证输入导致主线程阻塞。
 * 隐患点：目录未初始化 Git 仓库、新仓库尚无任何提交 (unborn HEAD) 或机器未安装 Git CLI 时将抛出异常，需安全捕获并返回空字符串。
 */
export async function getHeadCommit(targetPath: string): Promise<string> {
  const cwd = resolveGitWorkingDirectory(targetPath);
  if (!cwd) {
    return '';
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 2000
    });
    return (stdout || '').trim();
  } catch {
    // 非 Git 仓库或 Git 异常直接返回空串
    return '';
  }
}

