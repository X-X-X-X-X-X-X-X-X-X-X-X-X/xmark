import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { IBookmark, IDriftStatus } from '../types.js';

/*
 * 《核心位置》：计算代码行的 16 位短 Hash
 * 逻辑解释：
 * 1. 采用 SHA-256 摘要算法，先调用 trim() 规范化去除首尾空白字符与行结束符。
 * 2. 截取前 16 位 16 进制字符串作为对比基准，在保证极低碰撞率的同时大幅压缩存储空间。
 * 3. 规避了因格式化空格或 CRLF/LF 换行符差异导致的误判。
 */
export function computeLineHash(text: string): string {
  const normalized = text.trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/*
 * 《核心位置》：多工作区文件 Uri 解析器
 * 逻辑解释：
 * 1. 若外部已传入明确的目标文件 Uri，优先直接使用。
 * 2. 多根工作区下，根据 filePath 的首段文件夹名精准定位对应的子 WorkspaceFolder。
 * 3. 单根工作区下平滑拼接至唯一的根目录。
 */
export function resolveFileUri(filePath: string, targetFileUri?: vscode.Uri): vscode.Uri | undefined {
  if (targetFileUri) {
    return targetFileUri;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const isMultiRoot = folders.length > 1 || !!vscode.workspace.workspaceFile;

  if (isMultiRoot) {
    const slashIndex = normalized.indexOf('/');
    if (slashIndex !== -1) {
      const folderName = normalized.slice(0, slashIndex);
      const subPath = normalized.slice(slashIndex + 1);
      const matchedFolder = folders.find((f) => f.name === folderName);
      if (matchedFolder) {
        return vscode.Uri.joinPath(matchedFolder.uri, subPath);
      }
    }
  }

  return vscode.Uri.joinPath(folders[0].uri, normalized);
}

/*
 * 《核心位置》：流式高效提取目标代码行 (兼容多工作区)
 * 逻辑解释：
 * 1. 优先在 VS Code 内存打开的 TextDocument 缓冲中查找，命中即可实现零 I/O 耗时。
 * 2. 未打开时，基于 Node.js readline 逐行流式读取，一旦达到 targetLine 立即关闭并销毁流，杜绝全量读取大文件导致的内存暴涨。
 * 隐患点：若外部文件已被删除或目标行超出文件总行数，需捕获异常并返回空字符串。
 */
export async function getLineContent(filePath: string, targetLine: number, targetFileUri?: vscode.Uri): Promise<string> {
  const fileUri = resolveFileUri(filePath, targetFileUri);
  if (!fileUri) {
    return '';
  }

  // 1. 检查编辑器内存缓存
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === fileUri.toString()
  );
  if (openDoc) {
    if (targetLine > 0 && targetLine <= openDoc.lineCount) {
      return openDoc.lineAt(targetLine - 1).text;
    }
    return '';
  }

  // 2. 磁盘流式按需读取
  if (!fs.existsSync(fileUri.fsPath)) {
    return '';
  }

  return new Promise<string>((resolve) => {
    let resolved = false;
    const stream = fs.createReadStream(fileUri.fsPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let currentLine = 0;

    rl.on('line', (line) => {
      currentLine++;
      if (currentLine === targetLine) {
        resolved = true;
        rl.close();
        stream.destroy();
        resolve(line);
      }
    });

    rl.on('close', () => {
      if (!resolved) {
        resolve('');
      }
    });

    rl.on('error', () => {
      if (!resolved) {
        resolve('');
      }
    });
  });
}

/*
 * 《核心位置》：检测书签与当前环境的漂移状态 (支持多工作区)
 * 逻辑解释：
 * 1. 比对当前 Git HEAD Commit 与书签录入时的 commit。
 * 2. 比对当前文件的目标行 Hash 与记录时的 lineHash。
 * 3. 严格遵循“不进行任何自动纠偏移动”的准则，仅返回状态布尔值。
 */
export async function checkBookmarkDrift(
  bm: IBookmark,
  currentHeadCommit: string,
  targetFileUri?: vscode.Uri
): Promise<IDriftStatus> {
  const commitChanged = Boolean(bm.commit && currentHeadCommit && bm.commit !== currentHeadCommit);
  let contentChanged = false;

  const currentContent = await getLineContent(bm.filePath, bm.line, targetFileUri);
  const currentHash = computeLineHash(currentContent);
  contentChanged = bm.lineHash !== currentHash;

  return {
    hasChanged: commitChanged || contentChanged,
    commitChanged,
    contentChanged,
    currentCommit: currentHeadCommit
  };
}
