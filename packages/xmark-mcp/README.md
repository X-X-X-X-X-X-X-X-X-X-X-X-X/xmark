# xmark-mcp

XMark 书签管理器的 Model Context Protocol (MCP) 服务。  
允许 AI 编程助手（Cursor、Claude Desktop、Windsurf、Trae 等）通过标准 MCP 协议安全、规范地读写项目书签，自动提取代码行、计算 16 位短哈希与检测代码漂移，并与 VS Code 扩展实时热重载同步。

---

## 🚀 快速接入配置（推荐使用 npx 零安装）

在任意 MCP 客户端（如 Cursor、Claude Desktop、Windsurf、Trae 等）的配置文件中添加如下通用配置：

```json
{
  "mcpServers": {
    "xmark": {
      "command": "npx",
      "args": ["-y", "xmark-mcp"]
    }
  }
}
```

> **提示**：如果使用源码本地开发调试，可将 `command` 设为 `node`，并将参数替换为本地 `dist/index.js` 路径。

---

## 🛠️ 提供的 Tools 列表

| 工具名称 | 功能描述 | 核心参数 |
| :--- | :--- | :--- |
| `list_bookmarks` | 查询项目所有书签或按分组筛选，可附带检测代码漂移状态 | `groupId` (可选), `checkDrift` (可选布尔值) |
| `add_bookmark` | 在指定代码文件与行号打上书签，**自动读取当前代码行、计算 16 位短 SHA-256 哈希与 Git 提交并原子落盘**（返回精简状态与 ID） | `filePath` (必填), `line` (必填), `name` (可选), `groupId` (可选), `groupName` (可选) |
| `update_bookmark` | 更新已有书签（修改名称、挪动行号、调整分组），支持自动重算哈希（返回精简状态与 ID） | `id` (必填), `name` (可选), `line` (可选), `groupId` (可选), `refreshHash` (可选) |
| `delete_bookmark` | 删除指定书签 | `id` (必填) |
| `list_groups` | 获取所有书签分组及各组内包含的书签数量 | 无 |
| `create_group` | 创建新的业务书签分组 (分组 ID 由系统统一安全生成) | `name` (必填) |
| `delete_group` | 删除分组（默认分组 default 受保护不可删除，其他组内书签自动归入 default） | `id` (必填) |
| `get_drift_status` | 检测指定书签是否发生代码漂移 | `id` (必填) |
| `get_bookmark_by_location` | 按文件相对/绝对路径与行号高性能查找对应书签 (O(1) 内存索引) | `filePath` (必填), `line` (必填) |
| `search_by_name` | 按名称模糊查找书签或分组 (原生快速匹配，支持 target 筛选) | `query` (必填), `target` (可选: `all` \| `bookmark` \| `group`) |
| `get_by_id` | 按唯一 ID 查找书签或分组实体 (O(1) 双向内存索引) | `id` (必填) |

---

## 📚 提供的 Resources

- `xmark://bookmarks`：获取当前项目的完整书签与分组 Schema 数据 (JSON 格式)。

---

## 📦 本地开发与构建

```bash
cd packages/xmark-mcp
npm install
npm run build
```

产物生成在 `dist/index.js`，为独立自包含的可执行 ESM 脚本。

---

## 📄 License

MIT © [xxc](https://github.com/X-X-X-X-X-X-X-X-X-X-X-X-X/xmark)
