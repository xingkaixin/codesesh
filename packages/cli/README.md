# CodeSesh

<p align="center">
  <img src="https://codesesh.xingkaixin.me/logo.svg" alt="CodeSesh" width="120" height="120">
</p>

<p align="center"><strong>One place to see every AI coding session you've ever had.</strong></p>

CodeSesh scans your local machine, finds every AI agent session (Claude Code, Cursor, Kimi, Kimi-Code, Codex, Grok, Pi, OpenCode, ZCode, DSH), and surfaces them in a unified, beautiful Web UI.

## Quick Start

```bash
npx codesesh
```

Your browser will open at `http://localhost:4521` with all your sessions ready to browse. If that default port is busy, CodeSesh automatically tries the next available port.

## Features

- **Unified Timeline** — Browse sessions across all your AI agents in a single, searchable interface
- **Flexible Time Ranges** — Switch between rolling presets, all history, or a custom date range without restarting the server
- **Session Aliases** — Give important sessions memorable local names that carry through search, bookmarks, and activity views
- **Persistent Themes** — Choose light, dark, or system appearance and keep your UI preferences across sessions
- **Structured Global Search** — Search titles, messages, tool output, and file paths with filters for agent, project, smart tag, tool, file activity, and cost
- **Dashboard & Activity Trends** — See totals, daily activity, agent distribution, model usage, token trends, smart tags, bookmarks, and recent sessions
- **Project Browse Mode** — Open a dedicated projects view with project-level metrics, sessions, and cross-agent drill-down
- **Project & Nested Session Tree** — Group sessions by repository or project identity, while keeping subagent sessions under their parent
- **Smart Tags** — Automatically label bugfix, refactoring, feature work, testing, docs, planning, git, build/deploy, and exploration sessions
- **Bookmarks** — Save important sessions and keep them visible from the dashboard
- **Full Conversation Replay** — Read every message, tool call, and reasoning step exactly as it happened
- **File Activity Index** — Jump to files that were read, edited, created, deleted, or moved, and search sessions by file activity
- **Keyboard Navigation** — Move through views, focus search, and open shortcuts without leaving the keyboard
- **Agent Resume Commands** — Copy worktree-aware resume commands from supported agent session details
- **Resumable History Indexing** — Checkpoint large backfills, resume interrupted scans, and show durable progress
- **Cost & Token Visibility** — See token totals, cache tokens, recorded costs, and model-based cost estimates
- **SQLite Cache, Migrations & Search Index** — Restore session lists quickly, upgrade local schemas safely, and reuse the same local store for search
- **Zero Configuration** — Just run it. CodeSesh auto-discovers everything on your filesystem
- **100% Local & Private** — Your data stays on your machine. No accounts, no cloud sync, no cloud telemetry
- **Live Refresh** — Local session changes are picked up automatically while the server is running

## Supported Agents

| Agent       | Status       |
| ----------- | ------------ |
| Claude Code | ✅ Supported |
| Cursor      | ✅ Supported |
| Kimi        | ✅ Supported |
| Kimi-Code   | ✅ Supported |
| Codex       | ✅ Supported |
| Grok        | ✅ Supported |
| Pi          | ✅ Supported |
| OpenCode    | ✅ Supported |
| ZCode       | ✅ Supported |
| DSH         | ✅ Supported |

## Usage

```bash
# Start the web UI (default port 4521)
npx codesesh

# Choose a custom starting port
npx codesesh --port 8080

# Only show sessions active in the last 3 days
npx codesesh --days 3

# Jump directly to a session
npx codesesh --session claudecode://3b0e4ead-eba9-43e7-9fac-b30647e189f8

# Filter to sessions from current project
npx codesesh --cwd .

# Only show specific agent
npx codesesh --agent claudecode

# Print the session index as JSON instead of starting the server
npx codesesh --json

# Show performance trace logs
npx codesesh --trace
```

## CLI Options

| Flag        | Alias | Default | Description                                                 |
| ----------- | ----- | ------- | ----------------------------------------------------------- |
| `--port`    | `-p`  | `4521`  | HTTP server starting port; falls back to the next available port if busy |
| `--host`    | —     | `127.0.0.1` | HTTP server bind address; non-loopback values require `--remote-access` |
| `--remote-access` | — | `false` | Enable token-protected access for any remotely exposed transport     |
| `--tls-cert` | — | — | Path to a TLS certificate; serves remote access over HTTPS            |
| `--tls-key` | — | — | Path to the private key matching `--tls-cert`                          |
| `--trust-proxy` | — | `false` | A reverse proxy in front of CodeSesh terminates TLS                    |
| `--days`    | `-d`  | `7`     | Only include sessions active in the last N days (`0` = all time) |
| `--cwd`     | —     | —       | Filter to sessions from a project directory                 |
| `--agent`   | `-a`  | all     | Filter to specific agent(s), comma-separated                |
| `--from`    | —     | —       | Sessions active after this date `YYYY-MM-DD`                |
| `--to`      | —     | —       | Sessions active before this date `YYYY-MM-DD`               |
| `--session` | `-s`  | —       | Directly open a session (`agent://session-id`)              |
| `--json`    | `-j`  | `false` | Print the session index as JSON and exit (metadata only)    |
| `--no-open` | —     | `false` | Don't auto-open the browser                                 |
| `--trace`   | —     | `false` | Print performance trace logs                                |
| `--cache`   | —     | `true`  | Use cached scan results when available                      |
| `--clear-cache` | — | `false` | Clear scan cache before starting                            |
| `-v`        | —     | —       | Print version number                                        |

Non-loopback binding and `--trust-proxy` both require `--remote-access`. This includes the common
setup where CodeSesh listens on `127.0.0.1` and a same-machine reverse proxy exposes it publicly.
CodeSesh prints a startup URL containing a fresh access token. Anyone with that URL can read the
indexed AI session history, so treat it as a password and do not share or persist it.

A token authenticates the requester but does not encrypt traffic. Without TLS, the token and full
session content travel over the network in plaintext, and URL tokens may be recorded in proxy logs.
Use one of these protected transports:

```bash
# CodeSesh terminates TLS
npx codesesh --host 0.0.0.0 --remote-access --tls-cert ./cert.pem --tls-key ./key.pem

# A reverse proxy terminates TLS; CodeSesh stays bound to loopback
npx codesesh --host 127.0.0.1 --remote-access --trust-proxy
```

`--trust-proxy` requires `X-Forwarded-Proto: https` on every API request. The listener must remain
unreachable except through that trusted proxy.

## Requirements

<!-- repo-fact:node-version:start -->

- Node.js 22+

<!-- repo-fact:node-version:end -->

## Links

- [GitHub](https://github.com/xingkaixin/codesesh)
- [Issues](https://github.com/xingkaixin/codesesh/issues)

## License

MIT
