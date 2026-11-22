---
layout: ../../../layouts/GuideLayout.astro
locale: zh
slug: claude-code-session-history
---

Claude Code 将完整的本地会话以 JSONL 文件保存在 `~/.claude/projects/<项目路径编码>/<session-id>.jsonl`，并将终端输入提示词单独记录在 `~/.claude/history.jsonl`。要在终端里恢复旧对话，直接运行 `claude --continue` 或 `claude --resume`；要跨项目搜索对话正文、工具输出和改过的文件，可运行 `npx codesesh --agent claudecode --days 0`。

## Claude Code 历史文件的保存位置

默认情况下，Claude Code 的本地数据都在 `~/.claude/` 下（`~` 表示当前用户主目录）。如果你设置了 `CLAUDE_CONFIG_DIR`，以下路径会全部移至该目录下。

- **完整会话记录（`~/.claude/projects/<项目>/<session-id>.jsonl`）：** 每行一条 JSON，完整包含用户消息、助手回复、思考过程、工具调用、命令输出与 Token 用量。Claude Code 会把每个工作目录路径编码成 `projects/` 下的子目录名。
- **子 Agent 记录（`<session>/subagents/*.jsonl`）：** 当 Claude Code 启动子 Agent 或工作流时，其 JSONL 与 `.meta.json` 会放在父会话目录下的 `subagents/` 中。CodeSesh 会把这些子会话自动归组到父会话下方。
- **终端输入历史（`~/.claude/history.jsonl`）：** 仅记录你输入过的提示词和时间戳，供命令行历史回溯，不包含助手回复和工具执行结果。

因此，当你需要找回某次修改思路、命令报错或代码上下文时，真正需要查看的是 `~/.claude/projects/` 下的 JSONL 文件，而不是 `history.jsonl`。

## 用原生命令列出并打开之前的会话

如果你已经在原项目目录里，用 Claude Code 自带的命令行参数最直接。

继续当前目录下最近一次会话：

```sh
claude --continue
```

打开交互式列表，浏览并选择历史会话：

```sh
claude --resume
```

已知具体会话 ID 时（例如从 CodeSesh 或 JSONL 文件名中拿到），直接恢复：

```sh
claude --resume <session-id>
```

在已经打开的 Claude Code 对话中，也可以直接输入 `/resume` 切换历史会话。

## 为什么旧的 Claude Code 会话会消失

如果在 `claude --resume` 或 `~/.claude/projects/` 里找不到几周前的对话，通常有以下三个原因：

- **本地自动清理（`cleanupPeriodDays`）：** Claude Code 会按 `~/.claude/settings.json` 中的 `cleanupPeriodDays` 自动删除过期的本地会话文件（默认 30 天）。一旦源文件被删，除非你之前做过备份或已经被 CodeSesh 提前索引进本地 SQLite，否则无法恢复。
- **切换了工作目录或 git worktree：** Claude Code 按项目路径划分会话目录。在上级目录或另一个 worktree 里运行 `claude --resume`，看不到原路径下的会话。
- **设置了不同的 `CLAUDE_CONFIG_DIR`：** 使用独立配置目录启动时，会话不会写入默认的 `~/.claude/projects/`。

## 用 CodeSesh 跨项目搜索和回放 Claude Code 历史

当你需要跨仓库搜一句话、查某段工具报错，或反查某个文件被哪次会话改过时，原生列表就不够用了。CodeSesh 会只读扫描 `~/.claude/projects/`，建立本地 SQLite 索引并在本机打开 Web 界面。

扫描本机所有历史 Claude Code 会话（不限于默认最近 7 天）：

```sh
npx codesesh --agent claudecode --days 0
```

只查看当前仓库下的 Claude Code 会话：

```sh
npx codesesh --agent claudecode --days 0 --cwd .
```

打开 Web 界面后，你可以：

- **跨项目全文搜索：** 一次检索标题、消息正文、工具输出和文件路径，点击命中结果直接定位到对应消息。
- **查看嵌套子 Agent：** 在同一个会话树里展开父会话与子 Agent，并汇总各层级的 Token 与估算成本。
- **按文件反查历史：** 输入 `src/auth.ts` 这类路径，列出所有读取、修改或创建过该文件的 Claude Code 会话。
- **一键复制恢复命令：** 在会话详情页复制带工作目录上下文的 `claude --resume <session-id>` 命令，直接回到终端继续。

如果你同时使用 Codex，可以继续查看 [Codex 历史会话指南](/zh/guides/codex-session-history/) 或[跨 Agent 历史查找总览](/zh/guides/session-history/)；不需要 Node.js 的独立二进制安装方式见[安装指南](/zh/guides/getting-started/)。

## 安全保留原始记录

CodeSesh 只读不写，不会修改或删除 `~/.claude/projects/` 下的任何原始文件。如果需要长期保留历史，可以在 `~/.claude/settings.json` 中调大 `cleanupPeriodDays`，并定期备份 `~/.claude/projects/`。
