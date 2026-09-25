# CodeSesh

<p align="center">
  <img src="assets/codesesh-logo-kinetic.svg" alt="CodeSesh Logo" width="128" height="128">
</p>


> **One place to see every AI coding session you've ever had.**

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
- **Structured Global Search** — Search titles, messages, tool output, and file paths with filters for agent, project, smart tag, tool, file activity, and cost
- **UI languages** — English, Simplified Chinese, and Japanese. Follows your browser language by default; use the language selector in the top toolbar to switch and save your preference. Session content and code stay in their original language.
- **Dashboard & Activity Trends** — Track daily activity, agent distribution, recent sessions, latest activity, token usage, model token shares for the selected date range, smart tags, and cost at a glance
- **Project Browse Mode** — Open a dedicated projects view with project-level metrics, sessions, and cross-agent drill-down
- **Project & Nested Session Tree** — Group sessions by repository or project identity, while keeping subagent sessions under their parent
- **Smart Tags** — Automatically label sessions such as bugfix, refactoring, feature work, testing, docs, planning, git operations, build/deploy, and exploration
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
- **Live Refresh** — File changes are picked up automatically, and the UI stays in sync without a restart

---

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

<!-- repo-fact:agents:end -->

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

### Install & Run

```bash
# Run the published CLI
npx codesesh
```

Your browser will open at `http://localhost:4521` with all your sessions ready to browse. If that default port is busy, CodeSesh automatically tries the next available port.

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
| `--remote-access` | — | `false` | Allow network or reverse-proxy exposure; API access is token-protected in every mode |
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

Every CodeSesh server process protects its API with a new access token, including the default
loopback listener, and includes that token in the printed startup URL. Non-loopback binding requires
`--remote-access`. A trusted proxy also requires `--remote-access`, a loopback `--host`, and an
HTTPS `--public-url`. Treat the startup URL as a password: do not publish it or place it in shared
shell history.

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

Model estimates use [models.dev](https://models.dev/api.json), cached in `~/.cache/codesesh/models-dev-pricing.json` for one hour. Startup reuses valid cached prices; missing or expired prices are refreshed before scanning, with a 10-second timeout. Network failures fall back to stale cached or bundled prices. Subsequent scans recalculate previously unpriced sessions when their model prices become available.

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

# Deploy landing page to Cloudflare Pages
pnpm --filter @codesesh/www deploy:cf
```

Rust backend tests run through Cargo. `test:coverage` measures the TypeScript contract and Web
code covered by Vitest; it does not measure Rust coverage. Playwright exercises the browser against
the native server. Backend process contracts and the fixed Node reference provide separate
compatibility checks.

The Pages deployment uses `apps/www/public/_headers` to cache fingerprinted
`/_astro/` assets for one year. Keep HTML and unversioned public files on the
Pages defaults so deployments remain visible. Landing pages preload their hero
image, which Pages can use for Early Hints. These optimizations use the existing
Pages service. `apps/www/public/404.html` disables Pages' SPA fallback so missing
assets return an uncached 404 instead of a cacheable copy of the homepage.

Use one Cloudflare Web Analytics injection source for the landing page. When
Pages injects the beacon, leave `PUBLIC_ANALYTICS_TOKEN` unset; it is only a
fallback for deployments without automatic injection. Check both Pages and zone
settings if the production HTML contains multiple CF beacons. Umami is separate.

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
pnpm build:web
pnpm test
pnpm generate:rust-contract
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm build:rust
pnpm package:artifact:test
pnpm prepare:reference
pnpm test:backend
pnpm test:backend:compare
pnpm test:rust:slice
pnpm test:backend:full
pnpm test:migration
pnpm perf:check
pnpm test:coverage
pnpm --filter @codesesh/web test:bundle
pnpm exec playwright install --with-deps chromium
pnpm test:rust:browser
pnpm test:e2e
node scripts/rust/pack.mjs ${{ matrix.target }} target/release/${{ matrix.executable }}
node scripts/rust/smoke.mjs --contracts
node scripts/rust/verify-set.mjs
```

<!-- repo-fact:ci-commands:end -->

A local run covers the host platform. Native packaging targets macOS arm64/x64, Linux glibc x64,
and Windows x64; each target still needs its own runner and installed-package checks. See
[the packaging guide](docs/rust-packaging.md).

### Performance Benchmark

```bash
# Warm-cache benchmark against an automatically selected representative session
pnpm bench:perf -- --days 0 --iterations 3

# Cold-start benchmark with React render profiling enabled
pnpm bench:perf -- --cold --react-profile --target heaviest --navigation direct
```

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
