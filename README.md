# CodeSesh

<p align="center">
  <img src="assets/codesesh-logo-kinetic.svg" alt="CodeSesh Logo" width="128" height="128">
</p>


> **One place to see every AI coding session you've ever had.**

[Website](https://codesesh.xingkaixin.me/) · [Find Claude Code and Codex history](https://codesesh.xingkaixin.me/guides/session-history/) · [Installation guide](https://codesesh.xingkaixin.me/guides/getting-started/)

You've been coding with AI agents, and the conversations are scattered everywhere on your filesystem. Context is lost. Cost is invisible. History is buried.

**CodeSesh** fixes that. It scans your local machine, finds every AI agent session, and surfaces them in a unified, beautiful Web UI. Think of it as a time machine for your AI-assisted development workflow.

---

## Why CodeSesh?

Modern developers work with multiple AI coding agents simultaneously. Each tool stores its session history in its own proprietary format, in its own hidden directory. There's no way to search across them, compare costs, or revisit that brilliant conversation you had three weeks ago.

CodeSesh believes your session history belongs to **you** — and you deserve to see it all in one place.

**What you get:**

- **Unified Timeline** — Browse sessions across all your AI agents in a single, searchable interface
- **Flexible Time Ranges** — Switch between rolling presets, all history, or a custom date range without restarting the server
- **Session Aliases** — Give important sessions memorable local names that carry through search, bookmarks, and activity views
- **Persistent Themes** — Choose light, dark, or system appearance and keep your UI preferences across sessions
- **Structured Global Search** — Search titles, messages, tool output, and file paths with filters for agent, project, smart tag, tool, file activity, and cost. Match Chinese substrings and open message results at the first matching message
- **UI languages** — English, Simplified Chinese, and Japanese. Follows your browser language by default; use the language selector in the top toolbar to switch and save your preference. Session content and code stay in their original language.
- **Dashboard & Activity Trends** — Track daily activity, agent distribution, recent sessions, latest activity, token usage, model token shares for the selected date range, smart tags, and cost at a glance
- **Project Browse Mode** — Open a dedicated projects view with project-level metrics, sessions, and cross-agent drill-down
- **Project & Nested Session Tree** — Group sessions by repository or project identity, while keeping subagent sessions under their parent
- **Smart Tags** — Automatically label sessions such as bugfix, refactoring, feature work, testing, docs, planning, git operations, build/deploy, and exploration
- **Bookmarks** — Save important sessions and keep them visible from the dashboard
- **Full Conversation Replay** — Read messages, tool calls, and reasoning in pages, or load the complete conversation. Keep your reading position and copy the full transcript as Markdown
- **File Activity Index** — Jump to files that were read, edited, created, deleted, or moved, and search sessions by file activity
- **Keyboard Navigation** — Move through views, focus search, and open shortcuts without leaving the keyboard
- **Agent Resume Commands** — Copy worktree-aware resume commands from supported agent session details, with the source machine and where to run the command clearly identified
- **Resumable History Indexing** — Checkpoint large backfills, resume interrupted scans, and show durable progress
- **Cost & Token Visibility** — See token totals, cache tokens, recorded costs, and model-based cost estimates
- **Session Receipts** — Inspect model and token-category usage with available cost breakdowns, then export the complete receipt as a PNG
- **SQLite Cache, Migrations & Search Index** — Restore session lists quickly, upgrade local schemas safely, and reuse the same local store for search
- **Zero Configuration** — Just run it. CodeSesh auto-discovers everything on your filesystem
- **Local by Default** — Standalone history stays on your machine. Optional Workers send sessions to your self-hosted Hub; no account or cloud telemetry is required
- **Live Refresh** — File changes are picked up automatically, and the UI stays in sync without a restart

---

## Multiple machines with Hub and Worker

Run `codesesh hub` for a query-only Web UI and pair an independent `codesesh worker` on each machine you want to collect from. The source-node panel guides pairing, shows collection health, and manages rescans and Worker replacement. User-level background service commands are available on macOS, Linux, and Windows. See the [Hub/Worker guide](docs/hub-worker.md) for setup, migration, and recovery.

## Supported Agents

<!-- repo-fact:agents:start -->

| Agent       | Status    |
| ----------- | --------- |
| Claude Code | Supported |
| Cursor      | Supported |
| Kimi-Cli    | Supported |
| Kimi-Code   | Supported |
| Codex       | Supported |
| Grok        | Supported |
| Pi          | Supported |
| OpenCode    | Supported |
| ZCode       | Supported |
| DSH         | Supported |
| DeepChat    | Supported |
| Cherry Studio | Supported |
| MiniMax Code | Supported |

| Antigravity CLI | Partial support |

<!-- repo-fact:agents:end -->

Antigravity CLI supports local SQLite conversations, titles, workspace metadata, and tool calls. Tool outcomes and usage remain unknown. IDE `.pb` histories are not supported. See the [compatibility notes](docs/antigravity-cli-integration.md).

OpenCode supports V1 SQLite history and the V2 `2.0.15` schema. Set `OPENCODE_DB` to select a custom database (relative to `XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` by default). V2 migration must finish before scanning; session totals prevent copied fork history from being counted again. See the [compatibility design](docs/opencode-v2-integration.md) for supported messages and validation limits.

MiniMax Code supports CLI 0.4.12 `v2/sqlite/runtime-state.sqlite`, including session trees, reasoning, tools, and usage. Discovery selects the first database under `~/.minimax` or `~/.minimax-code`; `MINIMAX_DATA_DIR` takes precedence over `MAVIS_DATA_DIR`. Refresh detects updates and removals as well as new messages. Media retains available references; legacy ledger layouts and Desktop compatibility are unverified. See the [integration design](docs/minimax-code-integration.md).

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

More agents coming soon. See the [extension checklist](#extending).

---

## Quick Start

### Prerequisites

<!-- repo-fact:node-version:start -->

- Node.js 22+ for the npm launcher; the standalone native executable does not require Node.
  Source builds use Node 24 from `mise.toml` and Rust from `rust-toolchain.toml`

<!-- repo-fact:node-version:end -->

<!-- repo-fact:pnpm-version:start -->

- pnpm 12.4.2 for building from source

<!-- repo-fact:pnpm-version:end -->

Native targets are macOS arm64/x64, Linux x64 GNU with **glibc 2.35 or later**, and Windows x64.
Linux CI and release validation use Ubuntu 22.04. Older glibc, musl, and Linux arm64 are not supported
by this release.

### Install & Run

```bash
# Run the published CLI
npx codesesh
```

Your browser will open at `http://localhost:4521` with all your sessions ready to browse. If that default port is busy, CodeSesh automatically tries the next available port.

### Native installation (no Node.js required)

macOS / Linux x64 (glibc 2.35+):

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | sh
codesesh
```

The default directory is `~/.local/bin`. Run the installer again to update. To select a version or directory:

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | CODESESH_VERSION=1.1.1 CODESESH_INSTALL_DIR="$HOME/.local/bin" sh
```

macOS (Homebrew):

```sh
brew install xingkaixin/tap/codesesh
codesesh
# Update
brew upgrade codesesh
```

Windows x64 (install Scoop first):

```powershell
scoop bucket add xingkaixin https://github.com/xingkaixin/scoop-bucket
scoop install xingkaixin/codesesh
codesesh
# Update
scoop update codesesh
```

Stop CodeSesh before updating, then restart it. Each channel manages its own installation; check PATH
if you have installed through multiple channels. The shell installer does not edit shell configuration
or overwrite symlinks. Uninstall with `brew uninstall codesesh`, `scoop uninstall codesesh`, or remove
`codesesh` from the shell installer's directory. User configuration and indexes are retained.

### Build from Source

```bash
git clone https://github.com/xingkaixin/codesesh.git
cd codesesh

pnpm install
pnpm build
pnpm serve
```

The local server runs the Rust executable with its embedded Web UI. Build the Web assets before
compiling a release executable; `pnpm build` coordinates the repository build.

---

## Usage

### Basic Usage

```bash
# Start the web UI (default port 4521)
npx codesesh

# Choose a custom starting port
npx codesesh --port 8080
npx codesesh -p 8080

# Start without auto-opening the browser
npx codesesh --no-open
```

### Filter by Time

```bash
# Only show sessions active in the last 3 local calendar days
npx codesesh --days 3

# Show all sessions (no time limit)
npx codesesh --days 0

# Show sessions active on or after a specific date (overrides --days)
npx codesesh --from 2025-01-01

# Show sessions within a date range
npx codesesh --from 2025-01-01 --to 2025-03-31
```

### Filter by Directory

```bash
# Only show sessions from the current project
npx codesesh --cwd .

# Only show sessions from a specific path
npx codesesh --cwd /Users/you/projects/my-app
```

### Filter by Agent

```bash
# Only show Claude Code sessions
npx codesesh --agent claudecode

# Only show Cursor sessions
npx codesesh --agent cursor

# Multiple agents, comma-separated
npx codesesh --agent claudecode,cursor
```

### Open a Specific Session

```bash
# Jump directly to a session by agent and ID
npx codesesh --session claudecode://3b0e4ead-eba9-43e7-9fac-b30647e189f8
```

### JSON Output (for scripting)

```bash
# Print the session index as JSON instead of starting the server
npx codesesh --json
npx codesesh -j
```

The output is an index, not an archive: an `agents` summary and a `sessions` array of session
metadata — reference, title, directory, project identity,
timestamps, token/cost stats and smart tags. It does **not** include messages, tool calls,
reasoning or file activity, so it is not a backup of your history. Session content stays in each
agent's own data directory.

### CLI Options Reference

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `4521` | HTTP server starting port; falls back to the next available port if busy |
| `--host` | — | `127.0.0.1` | HTTP server bind address; default is local-only, set explicitly (e.g. `0.0.0.0`) to expose on the network |
| `--auth` | — | `false` | Require an API access token for local access |
| `--remote-access` | — | `false` | Allow network or reverse-proxy exposure; always require an API access token |
| `--tls-cert` | — | — | Path to a TLS certificate; serves remote access over HTTPS |
| `--tls-key` | — | — | Path to the private key matching `--tls-cert` |
| `--trust-proxy` | — | `false` | A reverse proxy in front of CodeSesh terminates TLS |
| `--public-url` | — | — | Public HTTPS origin used with `--trust-proxy` for startup links |
| `--days` | `-d` | `7` | Only include sessions active in the last N local calendar days (`0` = all time) |
| `--cwd` | — | — | Filter to sessions from a project directory (`.` = current dir) |
| `--agent` | `-a` | all | Filter to specific agent(s), comma-separated |
| `--from` | — | — | Sessions active on or after this date `YYYY-MM-DD` (overrides `--days`) |
| `--to` | — | — | Sessions active on or before this date `YYYY-MM-DD` |
| `--session` | `-s` | — | Directly open a session (`agent://session-id`) |
| `--json` | `-j` | `false` | Print the session index as JSON and exit (metadata only, no messages) |
| `--no-open` | — | `false` | Don't auto-open the browser |
| `--trace` | — | `false` | Print performance trace logs |
| `--cache` | — | `true` | Use cached scan results when available |
| `--clear-cache` | — | `false` | Clear scan cache before starting |
| `-v` | — | — | Print version number |
| `-h` / `--help` | — | — | Show help |

Local access does not require an API token by default. Use `--auth` to enable token authentication
on the loopback listener. Without it, other users and processes on the same machine can access
indexed sessions and write APIs. Host and cross-origin request checks remain enabled.

`--remote-access` always enables token authentication, including when the backend listens on
loopback behind a reverse proxy. Non-loopback binding requires `--remote-access`. A trusted proxy
also requires a loopback `--host` and an HTTPS `--public-url`. When authentication is enabled, each
server process generates a fresh token and includes it in the startup URL. Treat that URL as a
password: do not share or persist it. Worker pairing and upload credentials are unchanged.

A token proves who is asking; it does not hide the answer. Without TLS the token and the full
session content travel the network in the clear, and the token in the URL can end up in reverse
proxy access logs. Pick one of:

```bash
# CodeSesh terminates TLS
npx codesesh --host 0.0.0.0 --remote-access --tls-cert ./cert.pem --tls-key ./key.pem

# A reverse proxy terminates TLS; CodeSesh stays bound to loopback
npx codesesh --host 127.0.0.1 --remote-access --trust-proxy \
  --public-url https://codesesh.example.com
```

`--trust-proxy` requires every API request to arrive with `X-Forwarded-Proto: https` and refuses it
otherwise. That header validates the proxy's forwarding configuration; it cannot prove which client
sent it. CodeSesh therefore enforces a loopback backend so network clients cannot reach the HTTP
listener directly. The printed and automatically opened startup URL uses `--public-url`.

Using `--remote-access` without either TLS option still starts on a non-loopback address and prints
a warning that the transport is unencrypted.

Model estimates use [models.dev](https://models.dev/api.json), cached in `~/.codesesh/models-dev-pricing.json` for one hour. Startup reuses valid cached prices; missing or expired prices are refreshed before scanning, with a 10-second timeout. Network failures fall back to stale cached or bundled prices. Subsequent scans recalculate previously unpriced sessions when their model prices become available.

---

## Web UI Walkthrough

Once CodeSesh is running, here's what you'll find:

1. **Dashboard** — Start from a summary view with total sessions, total messages, total tokens, latest activity, daily activity, agent distribution, model token shares for the selected date range, token trends, smart tags, bookmarks, and recent sessions.
2. **Structured Global Search** — Query titles, messages, tool output, and file paths, then narrow results by agent, project, tag, tool, file activity, or cost.
3. **Projects** — Browse project-level totals, recent activity, agent mix, scoped dashboards, and sessions for a single repository or project identity.
4. **Session Tree Sidebar** — Browse sessions grouped by agent or project identity, with nested subagent sessions kept under their parents, and filter by agent or smart tag.
5. **Time Range Control** — Filter the entire Web UI with rolling presets, all history, or a custom date range.
6. **Session List** — Browse your sessions sorted by most recent. Each card shows the session title, working directory, message count, and total cost at a glance.
7. **Session Aliases, Smart Tags & Bookmarks** — Rename sessions locally, spot their intent quickly, and pin the ones you want to revisit.
8. **Session Detail** — Click any session to open a full replay with a receipt-style summary, user messages, assistant responses, tool invocations, reasoning steps, model labels, tracked file activity, and agent resume command copy.
9. **Keyboard Shortcuts** — Use the shortcuts panel to navigate sessions, open global search, focus search, and move between grouped content faster.
10. **Live Updates** — New or changed local sessions are reflected automatically while the server is running.

---

## Development

```bash
# Build all packages
pnpm build

# Clean build artifacts
pnpm clean

# Lint
pnpm lint
pnpm lint:fix

# Format
pnpm format
pnpm format:check

# Test
pnpm test
pnpm test:watch
pnpm test:coverage

# Performance benchmark
pnpm bench:perf

# Deploy landing page to Cloudflare Workers
pnpm deploy:www
```

Rust backend tests run through Cargo. `test:coverage` measures the TypeScript contract and Web
code covered by Vitest; it does not measure Rust coverage. Playwright exercises the browser against
the native server. Backend process contracts and the fixed Node reference provide separate
compatibility checks.

The landing page deploys to the `codesesh` Worker at `codesesh.xingkaixin.me`.
Use the globally installed `cf` CLI managed by mise, already authenticated with
Cloudflare; do not add `cf` or Wrangler as a project dependency. `pnpm deploy:www`
builds the contract and Astro site, prepares `.cloudflare/output/v0/`, then runs
`cf deploy --prebuilt`. This avoids automatic configuration installing build tools.
The output format is currently cf's v0 beta format, verified with cf 1.0.0-beta.12.
To validate without uploading, run `pnpm --filter @codesesh/contract build`,
`pnpm --filter @codesesh/www build:cf`, then
`(cd apps/www && cf deploy --prebuilt --dry-run)`.

The preparation script generates `_headers` with exact paths for built `/_astro/`
assets and caches them for one year. Workers applies wildcard headers to 404s too,
so exact paths keep missing assets out of that cache policy. HTML and unversioned
files use the Workers defaults. Finder metadata is excluded from deployment.
The deployment explicitly uses trailing-slash URLs and `404-page` handling with
`apps/www/public/404.html`, so missing assets return 404 instead of the homepage.
Analytics uses Umami only; keep Cloudflare Web Analytics injection disabled.

The Pages migration is complete. The retired Pages project can be removed.
Only the production custom domain serves the site; `workers.dev` and version
preview URLs are explicitly disabled in the generated deployment configuration.

### Reproduce Required CI Checks

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the source of truth. CI runs
Rust and frontend checks, browser contracts, and native artifact validation. The following commands
list the workflow’s declared checks. Run them in their job order; rebuild Web after `pnpm clean`.
The packaging line containing `${{ matrix.* }}` is a CI template: locally use `pnpm package:artifact`.
`verify-set` needs artifacts collected from all four runners:

<!-- repo-fact:ci-commands:start -->

```bash
pnpm install --frozen-lockfile
node scripts/check-quality-task-coverage.mjs
pnpm build:web
pnpm lint
pnpm format:check
pnpm typecheck
pnpm typecheck:e2e
node scripts/release-preflight.mjs
node scripts/check-docs-paths.mjs
node scripts/check-docs-facts.mjs
pnpm clean
pnpm test:coverage
pnpm --filter @codesesh/web test:bundle
pnpm generate:rust-contract
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm test:rust:platform
pnpm build:rust
node --test scripts/rust/packaging.test.mjs
node --test scripts/rust/publish.test.mjs
pnpm test:backend
pnpm perf:check
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
node scripts/rust/pack.mjs ${{ matrix.target }} target/release/${{ matrix.executable }}
node scripts/rust/smoke.mjs --contracts
node scripts/rust/verify-set.mjs
```

<!-- repo-fact:ci-commands:end -->

A local run covers the host platform. Native packaging targets macOS arm64/x64, Linux x64 GNU (glibc 2.35+),
and Windows x64; each target still needs its own runner and installed-package checks. See
[the packaging guide](docs/rust-packaging.md).

### Performance Benchmark

```bash
# Warm-cache benchmark against an automatically selected representative session
pnpm bench:perf -- --days 0 --iterations 3

# Cold-start benchmark with React render profiling enabled
pnpm bench:perf -- --cold --react-profile --target heaviest --navigation direct
```

### CI and release boundaries

Frontend, contract, coverage, documentation, and the complete Rust suite run once on Linux / Node 24.
All four native targets compile and run platform-dependent checks: filesystem discovery, migration,
watchers, SQLite persistence, native services, process lifecycle, and packaging. macOS and Windows
use `pnpm test:rust:platform`; npm installation is verified on Node 22.0.0 and Node 24 for each target.
See [the test policy](docs/testing.md) for the platform selection. Legacy Node differential suites
have been retired. The pinned Node package remains available only for manual performance benchmarks.

Version 1.1.0 prepares the native Rust backend for release. Version and changelog updates do not
publish packages. The Release workflow only runs for `v*` tags; publication requires separate
authorization and completion of the [release checklist](docs/release-guide.md).

### Dev Workflow

Build and start the native app:

```bash
pnpm dev
```

After backend or embedded Web changes, rebuild and restart the process. `pnpm serve` starts an
existing build. To pass arguments directly after a build:

```bash
./target/release/codesesh --cwd . --days 3
```

The separate Astro site supports `pnpm dev:www`.

### Project Structure

```text
crates/codesesh-core/src/agents/       Agent adapters and source parsing
crates/codesesh-core/src/discovery/    Discovery, incremental scans, and backfill
crates/codesesh-core/src/runtime/      Watcher, single writer, and publication
crates/codesesh-core/src/storage/      SQLite schema, migrations, messages, and FTS
crates/codesesh-core/src/pricing/      Model prices and fixed pricing generations
crates/codesesh-core/src/analytics/    Dashboard and project aggregation
crates/codesesh-core/src/search/       Structured search and file activity
crates/codesesh-core/src/state/        Bookmarks and aliases
crates/codesesh-cli/src/               Clap CLI, Axum HTTP, embedded Web, and logs
crates/codesesh-cli/npm/               Thin npm launcher
packages/contract/src/                Browser-safe contracts and pure logic
packages/contract/src/generated/      Rust-generated TypeScript wire types
apps/web/                            React application
apps/www/                            Astro product site
scripts/rust/                        Native build, packaging, and benchmarks
```

`docs/architecture.md` describes how a scan flows through these; `docs/sqlite-storage.md` covers
the cache and search index; `docs/performance.md` describes what guards performance and where to add
a new guard.

### Extending

Agent source parsing and browser presentation have explicit registration points:

1. Add a Rust adapter under `crates/codesesh-core/src/agents/` and register its scan entry.
2. Add default paths and environment overrides in `crates/codesesh-core/src/discovery/paths.rs`.
3. Edit public metadata and presentation capabilities in `crates/codesesh-core/src/agents/catalog.json`,
   then run `pnpm generate:rust-contract`. The browser catalog is generated from this single source.
4. Add its SVG to `apps/web/public/icon/agent/` and `apps/www/public/icon/agent/`.
5. Register any custom tool display in `apps/web/src/components/session-detail/tool-strategy/`.

Use source-format fixtures and process contracts to verify messages, usage, tools, and incremental
updates. Registration checks cover icons, resume declarations, and custom tool strategies.


Local databases, model prices, and logs now default to `~/.codesesh/` (`%USERPROFILE%\.codesesh\`
on Windows). On the first migration, stop older CodeSesh instances and confirm the terminal prompt.
For non-interactive runs, pass `--migrate-data` after stopping older instances. Migration verifies data
before removing old files and reports every retained path. Existing `CODESESH_STATE_DIR` and
`CODESESH_LOG_DIR` overrides remain supported. See [data migration](docs/sqlite-storage.md#数据目录迁移).
