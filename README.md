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
- **Dashboard & Activity Trends** — Track daily activity, agent distribution, recent sessions, latest activity, token usage, model usage, smart tags, and cost at a glance
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

<!-- repo-fact:agents:end -->

More agents coming soon. See the [extension checklist](#extending).

---

## Quick Start

### Prerequisites

<!-- repo-fact:node-version:start -->

- Node.js 22+ for the published CLI; use the Node 24 toolchain pinned in `mise.toml` when
  building from source

<!-- repo-fact:node-version:end -->

<!-- repo-fact:pnpm-version:start -->

- pnpm 11.25.0 for building from source

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

The local server uses `packages/cli/dist/index.js` and opens the same Web UI.

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

1. **Dashboard** — Start from a summary view with total sessions, total messages, total tokens, latest activity, daily activity, agent distribution, model distribution, token trends, smart tags, bookmarks, and recent sessions.
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

`test:coverage` runs the Core and CLI suites in Node and the Web suite in
`happy-dom`. Coverage includes all production TypeScript in Core, CLI, and Web.
Package-level baselines prevent coverage regressions, while stricter targeted
thresholds protect the scanning, API, live runtime, hook, and interaction paths.
The Astro landing page is covered by Playwright rather than Vitest.

### Reproduce Required CI Checks

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the source of truth. CI runs the main
job on Node.js 22 and 24 across Linux, macOS, and Windows; the following sequence reproduces its
gates from the repository root:

<!-- repo-fact:ci-commands:start -->

```bash
# Dependencies and static gates
pnpm install --frozen-lockfile
node scripts/check-quality-task-coverage.mjs
pnpm lint
pnpm format:check
pnpm typecheck:e2e
node scripts/release-preflight.mjs
node scripts/check-docs-paths.mjs

# Algorithmic, build, documentation, and clean-rebuild gates
pnpm perf:check
pnpm build
node scripts/check-docs-facts.mjs
node packages/cli/dist/index.js --version
pnpm clean
pnpm build

# Unit, coverage, migration, and browser gates
pnpm test
pnpm test:coverage # includes pnpm check:coverage-scopes
pnpm test:migration
pnpm --filter @codesesh/web test:bundle
pnpm exec playwright install --with-deps chromium
pnpm exec playwright install-deps chromium
pnpm test:e2e

# Package artifact and installed-package gates
pnpm package:artifact:test
pnpm package:artifact
node scripts/smoke-package-artifact.mjs artifacts/npm/codesesh-*.tgz
```

<!-- repo-fact:ci-commands:end -->

The workflow limits `perf:check` and the clean-rebuild smoke test to Node.js 24, and runs the CLI
version smoke test on Node.js 22. A local run covers the commands; the pull request matrix remains
the cross-platform verification.

### Performance Benchmark

```bash
# Warm-cache benchmark against an automatically selected representative session
pnpm bench:perf -- --days 0 --iterations 3

# Cold-start benchmark with React render profiling enabled
pnpm bench:perf -- --cold --react-profile --target heaviest --navigation direct
```

### Dev Workflow (watch mode)

Open two terminals:

```bash
# Terminal 1 — watch & recompile on source changes
pnpm dev

# Terminal 2 — auto-restart server when dist changes
pnpm serve

# Or pass CLI flags directly:
node --watch packages/cli/dist/index.js --cwd . --days 3
```

### Project Structure

```text
packages/core/src/agents/       Agent adapters, registry, and registration
packages/core/src/analytics/    Dashboard aggregation
packages/core/src/contract/     Browser-safe types and shared pure logic
packages/core/src/discovery/    Session scanning, SQLite cache, and search index
packages/core/src/pricing/      Model price registry and cost estimation
packages/core/src/projects/     Project identity resolution
packages/core/src/search/       Session search across sources
packages/core/src/state/        Bookmarks, aliases, and preferences
packages/core/src/types/        Shared TypeScript types
packages/core/src/utils/        Utility functions

packages/cli/src/index.ts       CLI argument parsing and startup
packages/cli/src/server.ts      Hono server and lifecycle
packages/cli/src/api/           HTTP routes and request handlers
packages/cli/src/*-worker.ts    Scan, search-index, and smart-tag worker threads

apps/web/src/components/        Product and UI components
apps/web/src/hooks/             Client state and data synchronization
apps/web/src/lib/               HTTP API client and frontend utilities
apps/web/src/styles/            Global styles

apps/www/src/pages/             Product-site routes
apps/www/src/components/        Product-site components
apps/www/public/                Static product-site assets
```

`docs/architecture.md` describes how a scan flows through these; `docs/sqlite-storage.md` covers
the cache and search index; `docs/performance.md` describes what guards performance and where to add
a new guard.

### Extending

Agent metadata and runtime construction have separate, explicit declarations:

1. Create `packages/core/src/agents/<youragent>.ts`, implement `BaseAgent`, and export its data-root resolver.
2. Add its public identity and capabilities to `packages/core/src/contract/agent-catalog.ts`.
3. Add its factory and data-root resolver to `packages/core/src/agents/register.ts`.
4. Add its SVG to both `apps/web/public/icon/agent/` and `apps/www/public/icon/agent/`.
5. For a custom tool display strategy, add `apps/web/src/components/session-detail/tool-strategy/<youragent>.ts` and register its builder in that directory's `index.ts`.

The registration completeness test rejects missing icons, undeclared resume support, and custom strategy mismatches.
