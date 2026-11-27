---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: cursor-session-history
---

Cursor 会将本地 Composer 与对话历史保存在用户数据目录下的 SQLite 数据库 `globalStorage/state.vscdb` 中（macOS 为 `~/Library/Application Support/Cursor/User`，Linux 为 `~/.config/Cursor/User`，Windows 为 `%APPDATA%\Cursor\User`）。无需手写 SQL 查询数据库，直接运行 `npx codesesh --agent cursor --days 0` 即可在本地 Web 界面中跨项目搜索和回放 Cursor 历史对话。

## Cursor 历史对话的本地保存位置

默认情况下，Cursor 按操作系统规范存放用户数据目录。如果设置了 `CURSOR_DATA_PATH` 指向自定义的 `Cursor/User` 目录，CodeSesh 会优先读取该路径。

- **macOS：** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Linux：** `~/.config/Cursor/User/globalStorage/state.vscdb`（或 `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`）
- **Windows：** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

在 `state.vscdb` 内部，Cursor 将会话和消息气泡以 JSON 形式存在 `cursorDiskKV` 表的 `composerData:*`、`bubbleId:*` 与 `bubble:*` 键下。由于数据封装在 SQLite 中，常规文本搜索和 `grep` 无法直接检索内容。

## 用 CodeSesh 搜索和回放 Cursor 历史

在 Cursor 侧边栏里只能按当前工作区翻找较近对话，很难跨仓库检索几周前的报错、命令输出或某个文件对应的修改记录。CodeSesh 以只读方式打开 `state.vscdb`，解析 Composer 会话和工具调用，并在本机建立全文搜索索引。

扫描本机全部 Cursor 历史会话：

```sh
npx codesesh --agent cursor --days 0
```

仅查看当前代码仓库相关的 Cursor 会话：

```sh
npx codesesh --agent cursor --days 0 --cwd .
```

打开 `http://localhost:4521` 后，你可以：

- **跨工作区全文搜索：** 一次检索所有项目的提示词、回复正文、工具输出与涉及的文件路径。
- **按时间顺序回放：** 查看对话与工具执行结果，无需重新打开旧的 Cursor 窗口，也不会改动原数据库。
- **与命令行 Agent 统一浏览：** 去掉 `--agent cursor` 后，可在同一个项目树里同时查看 Cursor、Claude Code、Codex、OpenCode 与 Gemini CLI 的记录。

Cursor 是桌面端 IDE，不提供命令行恢复参数，因此 CodeSesh 专注提供检索与回放视图，不生成终端恢复命令。

## 找不到 Cursor 会话时怎么排查

- **加上 `--days 0`。** 默认命令只显示最近 7 个本地日历日内活跃的会话，使用 `--days 0` 或在界面切换到「全部」即可看到更早记录。
- **检查 `CURSOR_DATA_PATH`。** 如果使用自定义配置目录，请确保 `CURSOR_DATA_PATH` 指向包含 `globalStorage/state.vscdb` 的 `User` 目录。
- **了解用量与成本统计。** Cursor 仅在部分会话中记录输入/输出 Token；当模型与 Token 信息完整时，CodeSesh 会在本地估算成本，不上传任何会话内容。

如果你同时使用命令行工具，可查看 [Claude Code 历史会话指南](/zh/guides/claude-code-session-history/)、[Codex 历史会话指南](/zh/guides/codex-session-history/) 或 [本地历史会话总览](/zh/guides/session-history/)。

## 安全保留原始记录与导出分工

CodeSesh 始终以只读模式访问 `state.vscdb`，不会修改或删除 Cursor 数据。如需在重装或清理数据前做长期备份，请先关闭 Cursor，再直接备份 `Cursor/User/globalStorage/state.vscdb`。CodeSesh 专注本地搜索、回放与用量复盘；如需将 Cursor 对话导出为独立文件分享或归档，可搭配 [Agent Dump](https://agent-dump.xingkaixin.me/) 使用。
