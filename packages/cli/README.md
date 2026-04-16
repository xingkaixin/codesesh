# CodeSesh

<p align="center">
  <img src="https://codesesh.xingkaixin.me/logo.svg" alt="CodeSesh" width="120" height="120">
</p>

<p align="center"><strong>One place to see every AI coding session you've ever had.</strong></p>

CodeSesh scans your local machine, finds every AI agent session (Claude Code, Cursor, Kimi, Codex, OpenCode), and surfaces them in a unified, beautiful Web UI.

## Quick Start

```bash
npx codesesh
```

Your browser will open at `http://localhost:4321` with all your sessions ready to browse.

## Features

- **Unified Timeline** — Browse sessions across all your AI agents in a single, searchable interface
- **Full Conversation Replay** — Read every message, tool call, and reasoning step exactly as it happened
- **Cost & Token Visibility** — See exactly how many tokens and dollars each session consumed
- **Zero Configuration** — Just run it. CodeSesh auto-discovers everything on your filesystem
- **100% Local & Private** — Nothing leaves your machine. No accounts, no cloud sync, no telemetry

## Supported Agents

| Agent       | Status       |
| ----------- | ------------ |
| Claude Code | ✅ Supported |
| Cursor      | ✅ Supported |
| Kimi        | ✅ Supported |
| Codex       | ✅ Supported |
| OpenCode    | ✅ Supported |

## Usage

```bash
# Start the web UI (default port 4321)
npx codesesh

# Choose a custom port
npx codesesh --port 8080

# Only show sessions from the last 3 days
npx codesesh --days 3

# Filter to sessions from current project
npx codesesh --cwd .

# Only show specific agent
npx codesesh --agent claudecode

# Output JSON instead of starting server
npx codesesh --json
```

## CLI Options

| Flag        | Alias | Default | Description                                                 |
| ----------- | ----- | ------- | ----------------------------------------------------------- |
| `--port`    | `-p`  | `4321`  | HTTP server port                                            |
| `--days`    | `-d`  | `7`     | Only include sessions from the last N days (`0` = all time) |
| `--cwd`     | —     | —       | Filter to sessions from a project directory                 |
| `--agent`   | `-a`  | all     | Filter to specific agent(s), comma-separated                |
| `--from`    | —     | —       | Sessions created after this date `YYYY-MM-DD`               |
| `--to`      | —     | —       | Sessions created before this date `YYYY-MM-DD`              |
| `--json`    | `-j`  | `false` | Output JSON and exit (no server)                            |
| `--no-open` | —     | `false` | Don't auto-open the browser                                 |

## Requirements

- Node.js 18+

## Links

- [GitHub](https://github.com/xingkaixin/codesesh)
- [Issues](https://github.com/xingkaixin/codesesh/issues)

## License

MIT
