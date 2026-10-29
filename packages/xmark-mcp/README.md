# xmark-mcp

XMark 书签管理器的 Model Context Protocol (MCP) 服务。
允许 AI 编程助手（Cursor、Claude Desktop、Windsurf、Trae 等）通过标准 MCP 协议安全、规范地读写项目书签，自动提取代码行、计算 16 位短哈希与检测代码漂移，并与 VS Code 扩展实时热重载同步。

---

## 🚀 快速接入配置

### 1. Cursor 配置 (`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "xmark": {
      "command": "node",
      "args": ["<path-to-xmark>/packages/xmark-mcp/dist/index.js", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

### 2. Claude Desktop 配置 (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "xmark": {
      "command": "node",
      "args": ["<path-to-xmark>/packages/xmark-mcp/dist/index.js", "--workspace", "/absolute/path/to/your/project"]
    }
  }
}
```

---

## 🛠️ 提供的 Tools 列表

| 工具名称 | 功能描述 | 核心参数 |
| :--- | :--- | :--- |
| `list_bookmarks` | 查询项目所有书签或按分组筛选，可附带检测代码漂移状态 | `groupId` (可选), `checkDrift` (可选布尔值) |
| `add_bookmark` | 在指定代码文件与行号打上书签，**自动读取当前代码行、计算 16 位短 SHA-256 哈希与 Git 提交并原子落盘** | `filePath` (必填), `line` (必填), `name` (可选), `groupId` (可选), `groupName` (可选) |
| `update_bookmark` | 更新已有书签（修改名称、挪动行号、调整分组），支持自动重算哈希 | `id` (必填), `name` (可选), `line` (可选), `groupId` (可选), `refreshHash` (可选) |
| `delete_bookmark` | 删除指定书签 | `id` (必填) |
| `list_groups` | 获取所有书签分组及各组内包含的书签数量 | 无 |
| `create_group` | 创建新的业务书签分组 | `name` (必填), `id` (可选) |
| `delete_group` | 删除分组（默认分组 default 受保护不可删除，其他组内书签自动归入 default） | `id` (必填) |
| `get_drift_status` | 检测指定书签是否发生代码漂移 | `id` (必填) |

---

## 📦 本地构建

```bash
cd packages/xmark-mcp
npm install
npm run build
```
产物将生成在 `packages/xmark-mcp/dist/index.js`，为独立自包含的可执行 ESM 脚本。

