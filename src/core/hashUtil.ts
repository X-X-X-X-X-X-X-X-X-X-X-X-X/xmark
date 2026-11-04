import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { IWorkspaceIndexSchema } from '../types.js';

/**
 * 《核心位置》：计算代码行 16 位短 SHA-256 校验和
 * 逻辑解释：
 * 1. 先进行 trim() 消除行首行尾空白字符及换行符（CRLF/LF）的差异。
 * 2. 采用 SHA-256 哈希算法计算摘要，取前 16 位小写十六进制字符串。
 * 3. 在极低碰撞率的前提下提供紧凑的内容指纹，用于判断目标代码是否产生漂移。
 * 隐患点：空字符串或全空格文本的哈希值固定为 e3b0c44298fc1c14（sha256('')前16位），属正常表现。
 */
export function computeLineHash(text: string): string {
  const normalized = (text || '').trim();
  return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * 获取全局 ~/.xmark 存储根目录
 */
export function getXMarkHomeDir(): string {
  return path.join(os.homedir(), '.xmark');
}

/**
 * 获取全局 ~/.xmark/index.json 索引文件路径
 */
export function getXMarkIndexPath(): string {
  return path.join(getXMarkHomeDir(), 'index.json');
}

/**
 * 《核心位置》：跨平台工作区路径规范化与确定性 PathHash 计算
 * 逻辑解释：
 * 1. 通过 path.resolve 解析绝对路径，统一将反斜杠转换为 POSIX 正斜杠 '/'。
 * 2. 剔除路径末尾多余的 '/'（保留根路径如 'c:/' 或 '/'）。
 * 3. 在 Windows 平台下将路径统一转为小写，消除 VS Code Uri.fsPath（盘符小写 d:）与 Node process.cwd()（盘符大写 D:）的大小写差异。
 * 4. 对规范化后的路径计算 SHA-256 并截取前 16 位作为 pathHash，确保 VS Code 插件端与 MCP 服务端对同一工作区得出完全一致的哈希值。
 * 隐患点：符号链接（Symlink）或映射网络驱动器若以不同盘符打开会被视作不同工作区路径。
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  let resolved = path.resolve(workspacePath).replace(/\\/g, '/');
  if (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.replace(/\/+$/, '');
  }
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export function computeWorkspacePathHash(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * 根据工作区根路径解析对应的 ~/.xmark/{pathHash}.json 完整信息
 */
export function resolveWorkspaceStorageInfo(workspacePath: string): {
  normalizedPath: string;
  pathHash: string;
  fileName: string;
  storageFilePath: string;
} {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const pathHash = computeWorkspacePathHash(normalizedPath);
  const fileName = `${pathHash}.json`;
  const storageFilePath = path.join(getXMarkHomeDir(), fileName);
  return {
    normalizedPath,
    pathHash,
    fileName,
    storageFilePath
  };
}

/**
 * 《核心位置》：维护 ~/.xmark/index.json 工作区映射索引
 * 逻辑解释：
 * 1. 确保 ~/.xmark 目录存在，读取现有 index.json；若文件不存在或损坏则初始化空索引结构。
 * 2. 更新或注册当前工作区的 pathHash -> { workspacePath, file, updatedAt } 映射。
 * 3. 采用临时文件 + rename 原子替换方式写入，防止插件与 MCP 并发更新时造成索引文件损坏。
 * 隐患点：极端并发下 rename 在 Windows 可能出现短暂 EPERM，捕获后降级为直接写入保证可用性。
 */
export async function updateWorkspaceIndex(workspacePath: string): Promise<void> {
  const homeDir = getXMarkHomeDir();
  const indexPath = getXMarkIndexPath();
  const { normalizedPath, pathHash, fileName } = resolveWorkspaceStorageInfo(workspacePath);

  await fs.mkdir(homeDir, { recursive: true });

  let indexData: IWorkspaceIndexSchema = {
    version: 1,
    workspaces: {}
  };

  try {
    const rawContent = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(rawContent);
    if (parsed && typeof parsed.workspaces === 'object' && parsed.workspaces !== null) {
      indexData = {
        version: 1,
        workspaces: parsed.workspaces
      };
    }
  } catch {
    // 索引文件不存在或格式异常时，直接基于新结构重建
  }

  indexData.workspaces[pathHash] = {
    workspacePath: normalizedPath,
    file: fileName,
    updatedAt: Date.now()
  };

  const content = JSON.stringify(indexData, null, 2);
  const tmpPath = `${indexPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, indexPath);
  } catch {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 忽略临时文件清理异常
    }
    await fs.writeFile(indexPath, content, 'utf-8');
  }
}
