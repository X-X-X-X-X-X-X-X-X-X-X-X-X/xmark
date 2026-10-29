import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BookmarkCore } from '../../../src/core/bookmarkCore.js';
import { computeLineHash } from '../../../src/core/hashUtil.js';
import { DEFAULT_GROUP_ID } from '../../../src/types.js';

/**
 * 《核心位置》：解析工作区根目录与存储位置配置
 * 逻辑解释：
 * 1. 统一以当前进程工作目录 process.cwd() 作为唯一工作区根目录基准。
 *    杜绝 IDE 文本宏替换（如 ${workspaceFolder}）在多根工作区无法解析导致的字面量目录创建问题。
 * 2. 存储路径自动推断：若工程根目录下存在 bookmark.json 且不存在 .vscode/bookmark.json，则自动以 root 模式存储，否则默认遵循 .vscode/bookmark.json。
 * 隐患点：若在非代码工程目录中启动 MCP 进程，将在当前目录初始化 .vscode/bookmark.json。
 */
export function resolveWorkspaceContext(): { workspaceRoot: string; storageLocation: 'vscode' | 'root' } {
  const workspaceRoot = path.resolve(process.cwd());

  let storageLocation: 'vscode' | 'root' = 'vscode';
  const rootBookmarkPath = path.join(workspaceRoot, 'bookmark.json');
  const vscodeBookmarkPath = path.join(workspaceRoot, '.vscode', 'bookmark.json');

  if (fs.existsSync(rootBookmarkPath) && !fs.existsSync(vscodeBookmarkPath)) {
    storageLocation = 'root';
  }

  return { workspaceRoot, storageLocation };
}

async function main() {
  const { workspaceRoot, storageLocation } = resolveWorkspaceContext();

  const core = new BookmarkCore(workspaceRoot, storageLocation);
  await core.load();

  const server = new McpServer({
    name: 'xmark-mcp',
    version: '0.1.0'
  });

  // 1. Tool: list_bookmarks
  server.registerTool(
    'list_bookmarks',
    {
      description: '获取项目所有书签或按分组筛选书签，可附带检测代码漂移状态',
      inputSchema: {
        groupId: z.string().optional().describe('可选：指定筛选的分组 ID，如不提供则返回全部'),
        checkDrift: z.boolean().optional().describe('可选：是否同时比对磁盘代码检测代码漂移 (默认 false)')
      }
    },
    async ({ groupId, checkDrift }) => {
      await core.load();
      const bookmarks = core.getBookmarks(groupId);

      if (checkDrift) {
        const results = await Promise.all(
          bookmarks.map(async (bm) => {
            const currentLine = await core.getLineContent(bm.filePath, bm.line);
            const currentHash = computeLineHash(currentLine);
            const isDrifted = bm.lineHash !== currentHash;
            return {
              ...bm,
              currentLineText: currentLine,
              isDrifted
            };
          })
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(bookmarks, null, 2)
          }
        ]
      };
    }
  );

  // 2. Tool: add_bookmark
  server.registerTool(
    'add_bookmark',
    {
      description: '在指定代码文件和行号添加书签，自动读取目标代码行内容、计算 16 位短哈希与 Git 提交，并安全原子落盘',
      inputSchema: {
        filePath: z.string().describe('目标代码文件相对路径 (统一使用正斜杠 /，如 src/index.ts)'),
        line: z.number().int().min(1).describe('目标行号 (从 1 开始的正整数)'),
        name: z.string().optional().describe('可选：书签显示标题，缺省默认为 "filePath:line"'),
        groupId: z.string().optional().describe('可选：所属分组 ID，缺省加入 default 默认分组'),
        groupName: z.string().optional().describe('可选：所属分组名称 (若不存在将自动创建该分组)')
      }
    },
    async ({ filePath, line, name, groupId, groupName }) => {
      await core.load();
      const normalizedPath = filePath.replace(/\\/g, '/');

      const targetLineContent = await core.getLineContent(normalizedPath, line);
      if (!targetLineContent && !fs.existsSync(path.join(core.getWorkspaceRoot(), normalizedPath))) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[XMark MCP] 目标文件不存在: ${normalizedPath}`
            }
          ]
        };
      }

      const bookmark = await core.addBookmark({
        filePath: normalizedPath,
        line,
        name,
        groupId,
        groupName,
        autoCompute: true
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message: '书签添加成功',
                bookmark,
                preview: {
                  filePath: bookmark.filePath,
                  line: bookmark.line,
                  content: targetLineContent,
                  lineHash: bookmark.lineHash
                }
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // 3. Tool: update_bookmark
  server.registerTool(
    'update_bookmark',
    {
      description: '更新已有书签信息 (名称、行号、所属分组)，支持在代码重构行号位移后自动重算短哈希',
      inputSchema: {
        id: z.string().describe('书签唯一 ID'),
        name: z.string().optional().describe('可选：更新后的书签名'),
        line: z.number().int().min(1).optional().describe('可选：更新后的行号 (1-based)'),
        groupId: z.string().optional().describe('可选：移动到的目标分组 ID'),
        refreshHash: z.boolean().optional().describe('可选：是否按照当前磁盘代码行内容刷新 lineHash 解决漂移 (默认自动推断)')
      }
    },
    async ({ id, name, line, groupId, refreshHash }) => {
      await core.load();
      const updated = await core.updateBookmark(id, {
        name,
        line,
        groupId,
        refreshHash
      });

      if (!updated) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[XMark MCP] 未找到 ID 为 ${id} 的书签`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: '书签更新成功', bookmark: updated }, null, 2)
          }
        ]
      };
    }
  );

  // 4. Tool: delete_bookmark
  server.registerTool(
    'delete_bookmark',
    {
      description: '按书签唯一 ID 删除书签',
      inputSchema: {
        id: z.string().describe('待删除的书签 ID')
      }
    },
    async ({ id }) => {
      await core.load();
      const success = await core.deleteBookmark(id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success, message: success ? '书签已删除' : '未找到指定书签' })
          }
        ]
      };
    }
  );

  // 5. Tool: list_groups
  server.registerTool(
    'list_groups',
    {
      description: '获取当前所有书签分组及各组内包含的书签数量'
    },
    async () => {
      await core.load();
      const groups = core.listGroups();
      const result = groups.map((g) => ({
        ...g,
        bookmarkCount: core.getBookmarks(g.id).length
      }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // 6. Tool: create_group
  server.registerTool(
    'create_group',
    {
      description: '创建新的书签分组',
      inputSchema: {
        name: z.string().describe('分组显示名称'),
        id: z.string().optional().describe('可选：自定义分组 ID (缺省自动生成)')
      }
    },
    async ({ name, id }) => {
      await core.load();
      const group = await core.addGroup(name, id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: '分组创建成功', group }, null, 2)
          }
        ]
      };
    }
  );

  // 7. Tool: delete_group
  server.registerTool(
    'delete_group',
    {
      description: '删除指定分组 (注：默认分组 default 受保护不可删除，删除其他组时其内书签将自动归入 default 分组)',
      inputSchema: {
        id: z.string().describe('待删除的分组 ID (不能是 default)')
      }
    },
    async ({ id }) => {
      if (id === DEFAULT_GROUP_ID) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: '[XMark MCP] 默认分组 default 受到保护，严禁删除'
            }
          ]
        };
      }
      await core.load();
      const success = await core.deleteGroup(id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              message: success ? '分组已删除，关联书签已移至默认分组' : '未找到该分组'
            })
          }
        ]
      };
    }
  );

  // 8. Tool: get_drift_status
  server.registerTool(
    'get_drift_status',
    {
      description: '精准检查指定书签是否存在代码漂移 (对比 lineHash 与磁盘当前行内容的 16 位短哈希)',
      inputSchema: {
        id: z.string().describe('书签 ID')
      }
    },
    async ({ id }) => {
      await core.load();
      const status = await core.checkDrift(id);
      if (!status) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[XMark MCP] 未找到 ID 为 ${id} 的书签`
            }
          ]
        };
      }
      const bm = core.getBookmark(id)!;
      const currentLine = await core.getLineContent(bm.filePath, bm.line);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: bm.id,
                filePath: bm.filePath,
                line: bm.line,
                storedHash: bm.lineHash,
                currentLineText: currentLine,
                currentHash: computeLineHash(currentLine),
                isDrifted: status.hasChanged
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // 9. Resource: xmark://bookmarks
  server.registerResource(
    'xmark-bookmarks',
    'xmark://bookmarks',
    {
      title: 'Current Project Bookmarks',
      mimeType: 'application/json'
    },
    async () => {
      await core.load();
      return {
        contents: [
          {
            uri: 'xmark://bookmarks',
            mimeType: 'application/json',
            text: JSON.stringify(core.getSchema(), null, 2)
          }
        ]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[xmark-mcp] 致命错误:', err);
  process.exit(1);
});
