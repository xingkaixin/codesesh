---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: codex-session-history
---

Codex 将本地活跃会话按日期保存为 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，在 `~/.codex/session_index.jsonl` 中记录会话标题索引，并将归档会话移到 `~/.codex/archived_sessions/`。在命令行中可用 `codex resume` 或 `codex resume --last` 列出并恢复旧会话；如需在本地 Web 界面跨仓库搜索和回放 Codex 历史，可运行 `npx codesesh --agent codex --days 0`。

## Codex 会话目录结构

默认情况下，Codex 的本地文件位于 `~/.codex/`（`~` 代表当前用户主目录）。如果设置了 `CODEX_HOME`，Codex 与 CodeSesh 都会改读该根目录。

- **活跃会话（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）：** 每个文件为一条完整会话的 JSONL 记录，包含提示词、回复、思考步骤、终端命令、文件补丁与 Token 用量。
- **标题索引（`~/.codex/session_index.jsonl`）：** 记录会话 ID 与标题（`thread_name`）的映射。CodeSesh 会读取该文件，确保在列表和搜索中显示正确标题。
- **归档会话（`~/.codex/archived_sessions/`）：** 存放已在 Codex 中归档的对话。当前 CodeSesh 的 Codex 适配器默认只扫描 `sessions/`，不扫描 `archived_sessions/`。

如果直接用文本编辑器查看原始 JSONL 文件，请保持内容不被修改。

## 在命令行列出并恢复 Codex 会话

如果只需要在终端中快速找回最近的线程，可以使用 Codex 内置的恢复命令。

打开交互式列表选择历史会话：

```sh
codex resume
```

直接回到最近一次会话：

```sh
codex resume --last
```

按已知会话 ID 恢复（例如从 CodeSesh 复制的 ID）：

```sh
codex resume <session-id>
```

## 用 CodeSesh 浏览和搜索 Codex 历史会话

Codex 的 `rollout-*.jsonl` 按日期分目录，而不是按代码仓库归类，历史变多后很难靠文件名或 `grep` 找回几周前的某次改动。CodeSesh 作为本地 Codex 会话查看器，会解析所有 rollout 文件、按仓库身份自动归组、保留嵌套子 Agent，并把正文、命令输出和文件路径写入本地 SQLite 索引。

扫描本机所有 Codex 历史会话：

```sh
npx codesesh --agent codex --days 0
```

只查看当前仓库下的 Codex 会话：

```sh
npx codesesh --agent codex --days 0 --cwd .
```

打开 `http://localhost:4521` 后，你可以：

- **跨仓库全文搜索：** 直接搜索对话内容、命令输出或文件路径，无需翻找日期目录。
- **完整回放命令与改动：** 按时间顺序查看终端执行结果、补丁和推理过程。
- **查看 Token 与估算成本：** 按会话、项目或模型汇总 Token 与缓存命中，详见 [Token 用量与成本指南](/zh/guides/usage-and-costs/)。
- **一键复制恢复命令：** 在会话详情页直接复制带工作目录上下文的 `codex resume <session-id>` 命令。

## 排查找不到 Codex 会话的常见原因

- **检查 `archived_sessions/`：** 如果你在 Codex 里归档了该对话，文件会从 `sessions/` 移到 `archived_sessions/`，而 CodeSesh 默认不扫描归档目录。
- **使用 `--days 0`：** 直接运行 `npx codesesh` 默认只展示最近 7 天活跃的会话，查找旧记录时加 `--days 0` 或在界面切换为「全部」。
- **核对 `CODEX_HOME`：** 确认启动 CodeSesh 的终端与运行 Codex 时使用相同的 `CODEX_HOME` 环境变量。
- **等待首次索引完成：** 历史较多时首次扫描在后台运行，请等索引完成后再进行全文检索。

如果你还使用 Claude Code 或其他工具，可继续查看 [Claude Code 历史会话指南](/zh/guides/claude-code-session-history/)和[本地历史查找总览](/zh/guides/session-history/)；独立二进制安装方式见[安装指南](/zh/guides/getting-started/)。
