# CodeSesh

CodeSesh turns local AI coding history into searchable, replayable engineering memory.

It discovers sessions from Claude Code, Cursor, Kimi, Kimi-Code, Codex, Grok, Pi, OpenCode, ZCode, and DSH, then organizes them by project in one local index.

## Start

```bash
npx codesesh
```

CodeSesh scans supported local session stores and opens a Web UI at `http://localhost:4521`. If that port is busy, it tries the next available port. The published CLI requires Node.js 22 or later.

## Product Tour

### Overview

Review session, message, token, cost, agent, and recent activity data from one local index. Change the time window to recompute the overview.

### Project Tree

Group history by repository or project identity, keep subagent sessions under their parent, and aggregate message, token, and cost data by hierarchy.

### Session Replay

Read messages, tool calls, and file changes in sequence. Filter by message type and use file tracking to recover the context behind a task.

## Capabilities

### Discover

- Zero configuration: scan supported local agent sessions with one command.
- Unified timeline: browse ten AI coding agents in one interface.
- Live refresh: incrementally index changed sessions while the local server runs.

### Organize

- Project and nested session tree: group by repository and preserve parent-child relationships.
- Smart tags: identify common engineering work such as fixes, refactors, features, tests, docs, and planning.
- Session aliases: give important sessions memorable names for search and bookmarks.

### Recover

- Structured global search: search titles, messages, tool output, and file paths, then narrow the results with filters.
- File activity index: find sessions that read or changed a file.
- Keyboard navigation: move through views, search, and groups without leaving the keyboard.

### Replay

- Full conversation replay: inspect messages, tool calls, and reasoning steps in order.
- Cost and token visibility: compare token totals, cache tokens, recorded cost, and model-based estimates.
- Local SQLite index: restore, search, migrate, and back up one local database.

## Supported Agents

- Claude Code
- Cursor
- Kimi
- Kimi-Code
- Codex
- Grok
- Pi
- OpenCode
- ZCode
- DSH

## Data Boundary

CodeSesh does not upload AI coding session data. Session content, file paths, token statistics, recorded costs, and the SQLite index stay on the user's computer. The product requires no account, cloud sync, or session telemetry.

CodeSesh may fetch public model pricing metadata to estimate costs. That request does not contain session content.

## FAQ

### What is CodeSesh?

CodeSesh is a local developer tool for discovering, aggregating, searching, and replaying AI coding session history. It turns local records from ten supported agents into a project-aware engineering memory layer.

### Does CodeSesh upload local AI session data?

No. CodeSesh serves its Web UI on localhost and stores its index in local SQLite. It does not require an account, cloud sync, or session telemetry.

### How do I install and start CodeSesh?

Run `npx codesesh`. The CLI scans supported local AI coding sessions and opens the Web UI at `http://localhost:4521`.

### How does CodeSesh stay responsive with a large history?

The initial scan persists backfill progress. Later starts restore from the SQLite cache, file watchers update changed sessions incrementally, and long timelines use viewport virtualization.

## Links

- Product site: https://codesesh.xingkaixin.me/
- Chinese product site: https://codesesh.xingkaixin.me/zh/
- AI overview: https://codesesh.xingkaixin.me/llms.txt
- Full AI knowledge file: https://codesesh.xingkaixin.me/llms-full.txt
- GitHub: https://github.com/xingkaixin/codesesh
- npm: https://www.npmjs.com/package/codesesh

## 中文说明

CodeSesh 是一个本地开发者工具，用来发现、聚合、搜索和回放十种 AI 编码 Agent 的本地会话。会话内容与 SQLite 索引保留在用户电脑上，无需账号、云同步或会话遥测。
