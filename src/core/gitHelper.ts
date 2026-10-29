import * as child_process from 'node:child_process';
import * as util from 'node:util';

const execFileAsync = util.promisify(child_process.execFile);

/**
 * 《核心位置》：无宿主依赖的轻量 Git Commit Hash 获取器
 * 逻辑解释：
 * 1. 在指定工程工作区目录下直接调用 git CLI 获取 HEAD 的 40 位 SHA 校验码。
 * 2. 设置 2000ms 超时限制，避免外部 git 进程挂起或等待凭证输入导致主线程阻塞。
 * 隐患点：目录未初始化 Git 仓库或机器未安装 Git CLI 时将抛出异常，需安全捕获并返回空字符串。
 */
export async function getHeadCommit(cwd: string): Promise<string> {
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

