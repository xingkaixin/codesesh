---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: session-history
---

大多数本地 AI 编码 Agent 会把历史会话保存在用户主目录下的隐藏 JSONL 文件夹或 SQLite 数据库中：Claude Code 将完整对话保存在 `~/.claude/projects/`（输入历史在 `~/.claude/history.jsonl`），Codex 将 `rollout-*.jsonl` 保存在 `~/.codex/sessions/`，而 Cursor、OpenCode、Gemini CLI 也各有独立存储路径。CodeSesh 可以把这些本地记录聚合到一个可全文搜索的 Web 界面中，默认不上传任何数据。

如果需要具体工具的目录结构、原生恢复命令和清理机制排查，可直接阅读 [Claude Code](/zh/guides/claude-code-session-history/)、[Codex](/zh/guides/codex-session-history/)、[Cursor](/zh/guides/cursor-session-history/)、[OpenCode](/zh/guides/opencode-session-history/) 和 [Gemini CLI](/zh/guides/gemini-cli-session-history/) 专题指南。

## 常见 Agent 的默认历史存储位置

`~` 代表当前用户主目录。CodeSesh 默认扫描以下本地路径：

| Agent       | 默认历史路径                                                                                                               | 环境变量覆盖                    | 原生恢复命令      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------- |
| Claude Code | `~/.claude/projects/`                                                                                                      | `CLAUDE_CONFIG_DIR`             | `claude --resume` |
| Codex       | `~/.codex/sessions/`                                                                                                       | `CODEX_HOME`                    | `codex resume`    |
| Cursor      | `~/Library/Application Support/Cursor/User`（macOS）、`~/.config/Cursor/User`（Linux）、`%APPDATA%\Cursor\User`（Windows） | `CURSOR_DATA_PATH`              | —                 |
| OpenCode    | `~/.local/share/opencode/opencode.db`                                                                                      | `OPENCODE_DB` / `XDG_DATA_HOME` | `opencode -s`     |
| Gemini CLI  | `~/.gemini/tmp/`                                                                                                           | `GEMINI_CLI_HOME`               | `gemini --resume` |
| Droid       | `~/.factory/sessions/`                                                                                                     | `FACTORY_HOME_OVERRIDE`         | `droid --resume`  |
| Pi          | `~/.pi/agent/sessions/`                                                                                                    | `PI_CODING_AGENT_DIR`           | `pi --session`    |
| Antigravity | `~/.gemini/antigravity/conversations/`                                                                                     | `ANTIGRAVITY_CONVERSATIONS_DIR` | —                 |

请确保启动 CodeSesh 的终端与编码工具使用相同的环境变量。像 `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME` 指向的是工具的根目录，而不是直接指向 `projects/` 或 `sessions/`。

有两个常见细节值得注意：

- **Codex 归档目录：** 当前 Codex 适配器默认扫描 `~/.codex/sessions/`，不扫描 `~/.codex/archived_sessions/`。
- **Claude Code 输入记录与完整对话分离：** `~/.claude/history.jsonl` 只记录终端输入提示词，完整的回复、工具调用和子 Agent 会话位于 `~/.claude/projects/`。

## 原生命令行恢复与跨项目检索的区别

如果你就在原项目目录下、只想继续最近一次对话，直接用 `claude --resume` 或 `codex resume` 最快。但当你只记得一个报错片段、某个被改过的文件路径，或者忘了几周前用的是哪个工具时，原生命令行列表很难反查。

不安装任何工具也可以用文本编辑器直接打开 JSONL 文件，但单个文件里混杂了大量工具事件和元数据，跨目录检索效率很低。手动查阅时请保持原文件不变。

## 用 CodeSesh 搜索和回放历史会话

CodeSesh 会将受支持的本地记录建立到一个 SQLite 索引中，支持跨项目、跨 Agent 搜索消息正文、工具输出和文件路径。单机模式无需账号，所有记录留在你的本机。独立可执行文件和其他安装方式见[安装指南](/zh/guides/getting-started/)。

安装 Node.js 22 或更高版本后，在终端运行全量扫描：

```sh
npx codesesh --days 0
```

CodeSesh 会打开 `http://localhost:4521`（如果端口被占用，使用终端打印的地址）。浏览期间保持该进程运行。

**为什么加 `--days 0`？** 默认命令 `npx codesesh` 只展示最近 7 个本地日历日内活跃的会话，以加快首次启动；查找更早的对话时使用 `--days 0`。

## 按项目、Agent 或文件路径定位对话

假设你几周前在 `my-app` 仓库修过登录超时，但不记得当时用的是 Claude Code 还是 Codex：

1. 打开全局搜索，输入对话正文或报错中出现过的关键词。
2. 结合项目筛选、Agent 筛选或智能标签缩小范围。
3. 不记得原话时，直接搜文件路径（如 `src/auth.ts`），或在文件活动视图中反查所有读/改过该文件的会话。
4. 打开匹配的会话，按时间顺序回放消息、工具调用与思考过程；如需继续，可直接复制对应 Agent 的恢复命令。

在项目目录中启动时，可以只扫描当前仓库：

```sh
npx codesesh --days 0 --cwd .
```

只查看 Claude Code 和 Codex 时，可以运行：

```sh
npx codesesh --days 0 --agent claudecode,codex
```

回放只读取历史记录，不会重新执行命令或改动本地文件。可以先查看[搜索与会话回放演示](/zh/#tour)，或在[Token 用量与成本指南](/zh/guides/usage-and-costs/)中查看模型消耗统计。

<span id="troubleshooting"></span>

## 找不到会话时怎么排查

- **检查时间范围。** 用 `--days 0` 重新启动，或在界面将时间范围从 7 天切到「全部」，同时移除过严的 `--from`、`--to`、`--cwd` 或 `--agent` 参数。
- **检查清理周期与归档目录。** Claude Code 会按 `cleanupPeriodDays` 自动清理旧本地记录（默认 30 天）；Codex 归档后的会话会移到 `~/.codex/archived_sessions/`。
- **检查自定义根目录环境变量。** 确认启动 CodeSesh 的终端里能读到 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 等变量。
- **等待后台索引完成。** 首次全量回填在后台运行，列表先出现会话标题后，全文索引可能仍在进行。
- **反馈可复现的解析问题。** 如果源文件存在且可读但依然缺失，可[提交 Issue](https://github.com/xingkaixin/codesesh/issues)，附上 CodeSesh 版本、Agent 名称和脱敏后的错误信息。

## 了解本地索引的边界

CodeSesh 是只读查看器和搜索索引，不是原始记录的备份工具。它会在来源暂时消失时保留已入库记录，但无法恢复在扫描前已被删除的历史文件；`--json` 输出的也只是会话元数据，而非完整对话归档。

如果需要长期留存历史，请妥善备份 Agent 原始数据目录；如需将 Claude Code、Codex 或 Cursor 会话导出为独立文档，可配合 [Agent Dump](https://agent-dump.xingkaixin.me/) 使用（导出用 Agent Dump，检索回放与成本分析用 CodeSesh）。其他受支持工具与能力可在 [CodeSesh 产品介绍](/zh/)查看。

## 延伸阅读

- [你跟 AI 的每一次编码对话，都在悄悄消失](https://xingkaixin.me/posts/codesesh-ai-coding-sessions-disappearing/)：为什么 AI 编码对话容易在切换工具和终端后散落，以及 CodeSesh 的设计取舍。
- [每次跟 agent 聊完，你把最值钱的东西丢了](https://xingkaixin.me/posts/session-as-asset/)：讨论如何留住编码会话里的踩坑记录与工程判断，让它们之后还能被搜到。
