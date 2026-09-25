# CodeSesh

<p align="center">
  <img src="https://codesesh.xingkaixin.me/logo.svg" alt="CodeSesh" width="120" height="120">
</p>

<p align="center"><strong>One place to see every AI coding session you've ever had.</strong></p>

CodeSesh scans your local machine, finds sessions from supported AI coding agents, and surfaces them in a unified Web UI.

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
- **UI languages** — English, Simplified Chinese, and Japanese. Follows your browser language by default; use the language selector in the top toolbar to switch and save your preference. Session content and code stay in their original language.
- **Dashboard & Activity Trends** — See totals, daily activity, agent distribution, model token shares for the selected date range, token trends, smart tags, bookmarks, and recent sessions
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

<!-- repo-fact:agents:start -->

| Agent       | Status       |
| ----------- | ------------ |
| Claude Code | ✅ Supported |
| Cursor      | ✅ Supported |
| Kimi-Cli    | ✅ Supported |
| Kimi-Code   | ✅ Supported |
| Codex       | ✅ Supported |
| Grok        | ✅ Supported |
| Pi          | ✅ Supported |
| OpenCode    | ✅ Supported |
| ZCode       | ✅ Supported |
| DSH         | ✅ Supported |
| DeepChat    | ✅ Supported |
| Cherry Studio | ✅ Supported |
| MiniMax Code | ✅ Supported |

<!-- repo-fact:agents:end -->

OpenCode supports V1 SQLite history and the V2 `2.0.15` schema. Set `OPENCODE_DB` to select a custom database (relative to `XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` by default). V2 migration must finish before scanning; session totals prevent copied fork history from being counted again. See the [compatibility design](../../docs/opencode-v2-integration.md) for supported messages and validation limits.

MiniMax Code supports CLI 0.4.12 `v2/sqlite/runtime-state.sqlite`, including session trees, reasoning, tools, and usage. Discovery selects the first database under `~/.minimax` or `~/.minimax-code`; `MINIMAX_DATA_DIR` takes precedence over `MAVIS_DATA_DIR`. Refresh detects updates and removals as well as new messages. Media retains available references; legacy ledger layouts and Desktop compatibility are unverified. See the [integration design](../../docs/minimax-code-integration.md).

DeepChat supports the current unencrypted `app_db/agent.db`, including native and ACP sessions.
Set `DEEPCHAT_USER_DATA_DIR` to override its user data directory. Legacy `chat.db`,
SQLCipher-encrypted databases, and resume commands are not supported. ACP sessions are counted
under DeepChat; records also discovered from an external agent are not deduplicated.

Cherry Studio supports 2.x `Data/cherrystudio.sqlite`: Agent sessions (Claude Code, Pi, DSH)
and the selected branch of assistant chats. Chat messages and usage follow that branch;
alternative replies are excluded. Chats are grouped under the user data directory, while Agent
sessions retain their workspace. Set `CHERRYSTUDIO_USER_DATA_DIR` for custom or portable data
directories. Message usage is counted once from Cherry's stored statistics. USD costs are
preserved; other currencies use USD model estimates when pricing is available. Legacy 1.x
`agents.db`, independent subagent session trees, and resume commands are not supported.
Sessions are attributed to Cherry Studio without cross-agent deduplication.

## Usage

```bash
# Start the web UI (default port 4521)
npx codesesh

# Choose a custom starting port
npx codesesh --port 8080

# Only show sessions active in the last 3 local calendar days
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
| `--remote-access` | — | `false` | Allow network or reverse-proxy exposure; every API mode uses a token |
| `--tls-cert` | — | — | Path to a TLS certificate; serves remote access over HTTPS            |
| `--tls-key` | — | — | Path to the private key matching `--tls-cert`                          |
| `--trust-proxy` | — | `false` | A reverse proxy in front of CodeSesh terminates TLS                    |
| `--public-url` | — | — | Public HTTPS origin used with `--trust-proxy` for startup links       |
| `--days`    | `-d`  | `7`     | Only include sessions active in the last N local calendar days (`0` = all time) |
| `--cwd`     | —     | —       | Filter to sessions from a project directory                 |
| `--agent`   | `-a`  | all     | Filter to specific agent(s), comma-separated                |
| `--from`    | —     | —       | Sessions active on or after this date `YYYY-MM-DD`          |
| `--to`      | —     | —       | Sessions active on or before this date `YYYY-MM-DD`         |
| `--session` | `-s`  | —       | Directly open a session (`agent://session-id`)              |
| `--json`    | `-j`  | `false` | Print the session index as JSON and exit (metadata only)    |
| `--no-open` | —     | `false` | Don't auto-open the browser                                 |
| `--trace`   | —     | `false` | Print performance trace logs                                |
| `--cache`   | —     | `true`  | Use cached scan results when available                      |
| `--clear-cache` | — | `false` | Clear scan cache before starting                            |
| `-v`        | —     | —       | Print version number                                        |

Every CodeSesh server process protects its API with a fresh access token, including the default
loopback listener, and prints that token in the startup URL. Non-loopback binding requires
`--remote-access`. A trusted proxy also requires `--remote-access`, a loopback `--host`, and an
HTTPS `--public-url`. Anyone with the startup URL can read the indexed AI session history, so treat
it as a password and do not share or persist it.

A token authenticates the requester but does not encrypt traffic. Without TLS, the token and full
session content travel over the network in plaintext, and URL tokens may be recorded in proxy logs.
Use one of these protected transports:

```bash
# CodeSesh terminates TLS
npx codesesh --host 0.0.0.0 --remote-access --tls-cert ./cert.pem --tls-key ./key.pem

# A reverse proxy terminates TLS; CodeSesh stays bound to loopback
npx codesesh --host 127.0.0.1 --remote-access --trust-proxy \
  --public-url https://codesesh.example.com
```

`--trust-proxy` requires `X-Forwarded-Proto: https` on every API request. That header validates the
proxy configuration but cannot identify its sender, so CodeSesh enforces a loopback backend rather
than trusting the header as a network boundary. Startup links use the configured `--public-url`.

## Requirements

<!-- repo-fact:node-version:start -->

- Node.js 22+ for the npm launcher. The standalone native executable does not require Node.

<!-- repo-fact:node-version:end -->

## Links

- [GitHub](https://github.com/xingkaixin/codesesh)
- [Issues](https://github.com/xingkaixin/codesesh/issues)

## License

MIT

Supported native targets are macOS arm64/x64, Linux x64 GNU with **glibc 2.35 or later**, and
Windows x64. Linux CI and release validation run on Ubuntu 22.04. Older glibc, musl, and Linux arm64
are outside the supported targets for this release.

## Native implementation

The CLI uses Rust, Clap, Axum, Tokio, and SQLite. Web assets are embedded at release build time.
The npm package only selects the platform package and forwards arguments, environment, stdio,
signals, and exit status. It contains no application backend or fallback implementation.

Source builds require the Rust toolchain pinned in `rust-toolchain.toml`, plus Node and pnpm for
Web assets. See the repository's `docs/rust-packaging.md` for target-specific build and verification.
