---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: opencode-session-history
---

OpenCode 将本地历史会话保存在 SQLite 数据库 `~/.local/share/opencode/opencode.db` 中（若设置了 `XDG_DATA_HOME`，则位于 `$XDG_DATA_HOME/opencode/opencode.db`），也可通过 `OPENCODE_DB` 覆盖路径。在命令行继续某次对话可运行 `opencode -s <session-id>`；如果想在本地 Web 界面里跨仓库搜索消息、工具输出、文件改动与记录成本，运行 `npx codesesh --agent opencode --days 0`。

## OpenCode 会话数据库的保存位置

默认情况下，OpenCode 将会话、消息、工具调用、推理步骤和费用数据写入同一个本地 SQLite 文件：

- **默认路径：** `~/.local/share/opencode/opencode.db`
- **XDG 目录覆盖：** 设置 `XDG_DATA_HOME` 后位于 `$XDG_DATA_HOME/opencode/opencode.db`
- **直接指定数据库：** 设置 `OPENCODE_DB`（支持绝对路径或相对于 OpenCode 数据目录的文件名；`:memory:` 内存库会被跳过）

CodeSesh 同时兼容 OpenCode 的 V1（`session`）与 V2（`session_v2` / `session_message`）数据库结构，包括处于 V1 向 V2 迁移过程中的数据库。

## 在命令行恢复 OpenCode 会话

已知会话 ID 时，可直接用 OpenCode CLI 恢复对应上下文：

```sh
opencode -s <session-id>
```

在 CodeSesh 的会话详情页里，也可以一键复制带工作目录上下文的 `opencode -s <session-id>` 命令。

## 用 CodeSesh 搜索和回放 OpenCode 历史

由于 OpenCode 的历史记录封装在 SQLite 数据库中，仅靠文件系统很难跨项目搜索报错信息、命令输出或某次文件修改。CodeSesh 以只读方式打开 `opencode.db`，将历史对话整理为按项目归组的本地 Web 视图。

扫描本机全部 OpenCode 历史会话：

```sh
npx codesesh --agent opencode --days 0
```

仅查看当前仓库的 OpenCode 记录：

```sh
npx codesesh --agent opencode --days 0 --cwd .
```

在 `http://localhost:4521` 中，你可以：

- **全文检索消息与工具输出：** 跨仓库搜索提示词、助手回复、命令结果与涉及的文件路径。
- **查看嵌套子会话树：** 将子 Agent 会话保留在父会话之下，并按层级汇总 Token 与成本。
- **核对记录成本与推理过程：** OpenCode 原生记录 Token 与费用，CodeSesh 会与完整工具调用时间线一并呈现。
- **快速回到终端继续工作：** 找到目标会话后直接复制 `opencode -s <session-id>` 继续对话。

## 找不到 OpenCode 会话时怎么排查

- **检查 `OPENCODE_DB` 与 `XDG_DATA_HOME`。** 确保启动 CodeSesh 的终端与运行 OpenCode 的终端使用一致的环境变量。
- **加上 `--days 0`。** 默认启动只展示最近 7 天活跃的会话，使用 `--days 0` 或在界面切换到「全部」可查看更早历史。
- **确认未使用 `:memory:` 模式。** 若 `OPENCODE_DB=:memory:`，会话不会落盘，无法被外部工具读取。

也可以参考 [Claude Code 历史会话指南](/zh/guides/claude-code-session-history/)、[Codex 历史会话指南](/zh/guides/codex-session-history/) 和 [Token 用量与成本指南](/zh/guides/usage-and-costs/)。
