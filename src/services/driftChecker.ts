import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { IBookmark, IDriftStatus } from '../types.js';
import { computeLineHash } from '../core/hashUtil.js';

export { computeLineHash };

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
 * 《核心位置》：检测书签与当前环境的代码内容漂移状态 (支持多工作区)
 * 逻辑解释：
 * 1. 纯基于内容 Hash (lineHash) 进行对比，彻底移除粗粒度的 Git Commit 对比。
 * 2. 避免无关文件的 Git 提交导致项目中所有书签被错误标记为“已变更”。
 * 3. 只有当目标行的实际代码内容被修改（Hash 不一致）时，才触发变动告警。
 * 隐患点：若目标文件已被删除或无法读取，将默认判定为变动（Hash 不匹配）。
 */
export async function checkBookmarkDrift(
  bm: IBookmark,
  targetFileUri?: vscode.Uri
): Promise<IDriftStatus> {
  const currentContent = await getLineContent(bm.filePath, bm.line, targetFileUri);
  const currentHash = computeLineHash(currentContent);
  const contentChanged = bm.lineHash !== currentHash;

  return {
    hasChanged: contentChanged,
    contentChanged
  };
}
