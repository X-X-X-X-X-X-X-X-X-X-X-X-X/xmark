import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BookmarkCore } from '../../../src/core/bookmarkCore.js';
import { computeLineHash } from '../../../src/core/hashUtil.js';
import { DEFAULT_GROUP_ID, StorageLocation } from '../../../src/types.js';

/**
 * 《核心位置》：解析工作区根目录与动态判断存储位置
 * 逻辑解释：
 * 1. 统一以当前进程工作目录 process.cwd() 作为唯一工作区根目录基准，与 VS Code 插件端 workspaceFolders[0] 对齐。
 * 2. 优先判断工作区根目录下是否存在 bookmark.json：若存在则优先使用 'root' 模式 (bookmark.json)，否则使用 'global' 模式 (~/.xmark/{pathHash}.json)。
 * 3. 每次工具调用前通过 syncAndLoad(core) 动态刷新存储模式，使得用户在 VS Code 中切换 storageLocation 后 MCP 无需重启即可无缝跟随。
 */
export function resolveWorkspaceContext(): { workspaceRoot: string; storageLocation: StorageLocation } {
  const workspaceRoot = path.resolve(process.cwd());
  const rootBookmarkPath = path.join(workspaceRoot, 'bookmark.json');
  const storageLocation: StorageLocation = fs.existsSync(rootBookmarkPath) ? 'root' : 'global';
  return { workspaceRoot, storageLocation };
}

async function syncAndLoad(core: BookmarkCore): Promise<void> {
  const rootBookmarkPath = path.join(core.getWorkspaceRoot(), 'bookmark.json');
  const storageLocation: StorageLocation = fs.existsSync(rootBookmarkPath) ? 'root' : 'global';
  core.setStorageLocation(storageLocation);
  await core.load();
}

async function main() {
  const { workspaceRoot, storageLocation } = resolveWorkspaceContext();

  const core = new BookmarkCore(workspaceRoot, storageLocation);
  await core.load();

  const server = new McpServer({
    name: 'xmark-mcp',
    version: '0.1.6'
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
      await syncAndLoad(core);
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
      await syncAndLoad(core);
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

      /**
       * 《核心位置》：返回添加成功结果（精简格式）
       * 逻辑解释：
       * 1. 避免向调用方 dump 完整书签对象及目标代码行预览，显著减少网络载荷与上下文 Token 占用。
       * 2. 仅返回成功状态、提示信息与生成的书签 ID，便于客户端后续引用。
       * 隐患点：若旧版上游客户端依赖返回结构中原有的 bookmark 或 preview 详细字段，直接精简会导致取值 undefined。
       */
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: '书签添加成功',
                id: bookmark.id
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
      await syncAndLoad(core);
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

      /**
       * 《核心位置》：返回更新成功结果（精简格式）
       * 逻辑解释：
       * 1. 精简返回格式，仅返回成功状态、提示信息与被更新的书签 ID，避免传输全量详情。
       * 隐患点：若旧版上游客户端依赖返回结构中原有的 bookmark 完整属性，直接精简会导致取值 undefined。
       */
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: '书签更新成功',
                id: updated.id
              },
              null,
              2
            )
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
      await syncAndLoad(core);
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
      await syncAndLoad(core);
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
      description: '创建新的书签分组 (分组 ID 由系统统一自动生成)',
      inputSchema: {
        name: z.string().describe('分组显示名称')
      }
    },
    async ({ name }) => {
      await syncAndLoad(core);
      /**
       * 《核心位置》：创建分组
       * 逻辑解释：
       * 1. 分组 ID 统一由底层 BookmarkCore 自动生成（如 group_时间戳_随机串），禁止外部调用方传入自定义 ID。
       * 2. 避免客户端传入与已有分组冲突的非法或重复 ID，保证全局 ID 唯一性与格式统一。
       * 隐患点：若外部调用方期望指定固定 ID，移除该参数后外部传入将直接被 schema 校验拦截或忽略。
       */
      const group = await core.addGroup(name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: '分组创建成功', group }, null, 2)
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
      await syncAndLoad(core);
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
      await syncAndLoad(core);
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

  // 9. Tool: get_bookmark_by_location
  server.registerTool(
    'get_bookmark_by_location',
    {
      description: '按文件路径与行号高性能查找对应书签 (O(1) 索引查询)',
      inputSchema: {
        filePath: z.string().describe('代码文件相对路径或绝对路径 (如 src/index.ts)'),
        line: z.number().int().min(1).describe('代码行号 (1-based)')
      }
    },
    async ({ filePath, line }) => {
      await syncAndLoad(core);
      /**
       * 《核心位置》：按文件路径与行号查找书签
       * 逻辑解释：
       * 1. core.findByLocation 内部自动转为统一 POSIX 相对路径，并通过 locationIndex Map 进行 O(1) 极速匹配。
       * 2. 避免线性遍历全部书签列表。
       * 隐患点：若同一行存在多个书签覆盖，仅能返回最后索引到的一个。
       */
      const bookmark = core.findByLocation(filePath, line);
      if (!bookmark) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ found: false, message: '未找到指定位置的书签' }, null, 2)
            }
          ]
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ found: true, bookmark }, null, 2)
          }
        ]
      };
    }
  );

  // 10. Tool: search_by_name
  server.registerTool(
    'search_by_name',
    {
      description: '按名称模糊查找书签或分组 (高性能原生子串匹配，支持类型筛选)',
      inputSchema: {
        query: z.string().min(1).describe('搜索名称关键词 (大小写不敏感模糊匹配)'),
        target: z.enum(['all', 'bookmark', 'group']).optional().describe('可选：搜索范围，可选 all(默认) | bookmark | group')
      }
    },
    async ({ query, target = 'all' }) => {
      await syncAndLoad(core);
      /**
       * 《核心位置》：按名称模糊查找书签与分组
       * 逻辑解释：
       * 1. core.searchByName 基于原生小写子串匹配，避免动态正则编译与回溯。
       * 2. 支持 target 过滤，仅扫描目标集合，减少不必要的内存迭代。
       * 隐患点：搜索关键词为空字符时提前拦截，防止返回全量列表造成无谓开销。
       */
      const result = core.searchByName(query, target);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                target,
                totalBookmarks: result.bookmarks.length,
                totalGroups: result.groups.length,
                bookmarks: result.bookmarks,
                groups: result.groups
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // 11. Tool: get_by_id
  server.registerTool(
    'get_by_id',
    {
      description: '按唯一 ID 高性能查找书签或分组 (O(1) 索引查询)',
      inputSchema: {
        id: z.string().describe('待查找的书签 ID 或分组 ID')
      }
    },
    async ({ id }) => {
      await syncAndLoad(core);
      /**
       * 《核心位置》：按 ID 查找书签或分组
       * 逻辑解释：
       * 1. core.findById 通过 idIndex 双向 Map 极速定位，O(1) 返回匹配实体。
       * 2. 返回结果中带有 type 字段标明是 'bookmark' 还是 'group'。
       * 隐患点：若 ID 不存在直接返回 found: false，无需抛错。
       */
      const entry = core.findById(id);
      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ found: false, message: `未找到 ID 为 ${id} 的书签或分组` }, null, 2)
            }
          ]
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                found: true,
                type: entry.type,
                data: entry.data
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // 12. Resource: xmark://bookmarks
  server.registerResource(
    'xmark-bookmarks',
    'xmark://bookmarks',
    {
      title: 'Current Project Bookmarks',
      mimeType: 'application/json'
    },
    async () => {
      await syncAndLoad(core);
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
