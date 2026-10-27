# XMark - AI Code Bookmark (代码书签)

专为**人类开发者**与 **AI 编程助手**（Cursor / Claude / Copilot / Antigravity 等任意工具）深度协同打造的 VS Code 原生代码书签扩展。

---

## 核心特性

- 🌍 **真正通用的 AI 协同 (Zero Lock-in)**：
  - 核心存储依托透明标准的 `bookmark.json`，文件内置自然语言契约规范 (`_instructions`)；
  - **适用于任何支持读写文件的 AI 工具**（无论是 Cursor、Copilot、Claude Code 还是本地模型），无特定协议与平台绑定，最为通用务实；
  - 插件内置 `FileSystemWatcher` 与防抖写锁，AI 写入后侧边栏与行号区秒级热更新。
- 🔖 **书签分组管理**：支持自定义分组及系统默认分组，支持组内拖拽重排与跨组转移。
- 🖱️ **双重右键添加**：支持在**编辑器任意代码处**或**行号区（Gutter）右键**快速添加书签。
- 👁️ **行号区图标呈现**：在编辑器行号区域直接高亮显示书签图标（蓝色为正常书签，黄色为变动警告）。
- 🔍 **智能代码漂移感知 (Code Drift)**：
  - 记录 Git HEAD Commit 及目标行 16 位短 Hash (`lineHash`)；
  - 发生变动时**坚决不随意移动原书签行号**，而在侧边栏与行号区显示 `[已变更]` / 警告标记，Tooltip 直观展示变更对比；
  - 支持右键一键“更新为当前位置/Commit”。
- 💾 **灵活持久化配置**：可选存储在 `.vscode/bookmark.json` 或项目根目录下的 `bookmark.json`。
- 🌐 **原生 i18n 国际化**：遵循 VS Code 现代 `vscode.l10n` 原生标准，完整支持简体中文与英文。

---

## 存储契约与格式规范 (`bookmark.json`)

AI 工具可通过标准的文件读取与写入直接操作此文件：

```json
{
  "_instructions": "【XMark AI 操作指南】1. 请勿删除此字段与 groups 中的 default 分组；2. 新增书签的 groupId 必须匹配 groups 中的 id；3. filePath 必须使用 POSIX 正斜杠 /；4. lineHash 为目标行去除首尾空格后的 16 位 SHA-256 Hash 值；5. 行号 line 为 1-based 正整数。",
  "version": 1,
  "defaultGroupId": "default",
  "groups": [
    {
      "id": "default",
      "name": "默认分组",
      "order": 0
    }
  ],
  "bookmarks": [
    {
      "id": "bm_1719000000000_abcd",
      "groupId": "default",
      "name": "用户登录鉴权核心入口",
      "filePath": "src/controllers/auth.ts",
      "line": 42,
      "commit": "a1b2c3d4e5f67890",
      "lineHash": "7f8b2a1c0e4d5f6a",
      "order": 0,
      "createdAt": 1719000000000
    }
  ]
}
```

---

## 构建与调试

```bash
# 安装依赖
npm install

# 静态类型检查
npm run compile

# 构建打包产物 (dist/extension.js)
npm run build
```
