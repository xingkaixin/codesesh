# CodeSesh

CodeSesh turns local AI coding history into reusable engineering memory.

It discovers local sessions from Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode, then preserves problems, reasoning, attempts, file activity, and outcomes in one project-aware searchable memory layer.

## Start

```bash
npx codesesh
```

CodeSesh runs locally and opens a Web UI at `http://localhost:4521`.

## Product Tour

### Engineering Memory Overview

See collaboration patterns through agent activity, token trends, smart tags, and bookmarked sessions.

### Structured Global Search

Search titles, messages, tool output, and file paths, then filter by project, tag, tool, file activity, and cost.

### Session Replay

Replay messages, tool calls, and file changes in the order a feature or bug fix unfolded.

### Keyboard Navigation

Move through projects, sessions, and results efficiently so browsing history fits daily work.

## Features

### Discover

CodeSesh brings local sessions from different agents into one index.

- Zero Configuration: run one command and scan supported agent sessions on your filesystem.
- Live Refresh: local session changes appear automatically as new collaboration records are written.
- Unified Timeline: browse Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode sessions in one interface.

### Organize

CodeSesh puts sessions back into project, task, and engineering context.

- Engineering Memory Overview: see cross-agent activity, models, tokens, smart tags, and bookmarked sessions together.
- Project Browse Mode: open a project overview with project-level metrics, sessions, and cross-agent drill-down.
- Project-Aware Session Tree: group sessions by repository and project identity across supported agents.
- Smart Tags: label bugfix, refactor, feature, testing, docs, planning, Git, build, and exploration work.

### Recover

CodeSesh brings old decisions, paths, and context back into the current task.

- Structured Global Search: search titles, messages, tool output, and file paths with project, tag, tool, file activity, and cost filters.
- Session Bookmarks: save important records so solutions, debugging paths, and key decisions stay traceable.
- Keyboard Navigation: move across views, focus search, and navigate groups from the keyboard.

### Replay

CodeSesh reconstructs the full path from problem to result.

- Full Conversation Replay: read every message, tool call, and reasoning step in sequence.
- File Activity Index: jump to files that were read, edited, created, deleted, or moved, and recover sessions by file activity.
- Cost and Token Visibility: see token totals, cache tokens, recorded costs, and model-based estimates.
- SQLite Migrations and Local Index: use one local database for fast restore, structured search, file activity indexing, and schema migrations.
- Claude Code Resume Commands: copy worktree-aware `claude --resume` commands from Claude Code session details.
- Local and Private: session data stays on your machine.

## Supported Agents

- Claude Code
- Cursor
- Kimi
- Codex
- Pi
- OpenCode
- ZCode

## FAQ

### What is CodeSesh?

CodeSesh is a local developer tool for discovering, aggregating, searching, and replaying AI coding session history. It turns local records from Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode into a project-aware engineering memory layer for recovering decisions, file activity, and complete collaboration paths.

### Which AI coding tools does CodeSesh support?

CodeSesh currently supports Claude Code, Cursor, Kimi, Codex, Pi, OpenCode, and ZCode. Each tool connects through an agent adapter in the core package, then contributes sessions to unified lists, project browsing, structured search indexes, file activity, smart tags, token statistics, and full replay views.

### Does CodeSesh upload local AI session data?

CodeSesh runs on the user's machine and uses a local SQLite index with a local Web UI. Session content, file paths, token statistics, and cost estimates stay on the local computer, which suits developers who want ownership of AI coding context.

### How do you install and start CodeSesh?

The fastest way to start CodeSesh is running `npx codesesh` in a terminal. CodeSesh scans supported local AI coding sessions and opens the Web UI at `http://localhost:4521`; if that default port is busy, it automatically tries the next available port. The published CLI requires Node.js 22+; source development uses Node.js 24 and pnpm 11.11.0.

## Links

- Product site: https://codesesh.xingkaixin.me/
- AI overview: https://codesesh.xingkaixin.me/llms.txt
- Full AI knowledge file: https://codesesh.xingkaixin.me/llms-full.txt
- GitHub: https://github.com/xingkaixin/codesesh
- npm: https://www.npmjs.com/package/codesesh

## 中文说明

CodeSesh 是一个本地开发者工具，用来发现、聚合、搜索和回放 Claude Code、Cursor、Kimi、Codex、Pi、OpenCode、ZCode 的本地 AI 编码历史，把分散的协作记录沉淀成可复用的工程记忆。
