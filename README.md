# CodeSesh

<p align="center">
  <img src="assets/codesesh-logo-kinetic.svg" alt="CodeSesh Logo" width="128" height="128">
</p>


> **One place to see every AI coding session you've ever had.**

You've been coding with AI agents — Claude Code, Cursor, Kimi-Cli, Kimi-Code, Codex, Grok, Pi, OpenCode, ZCode — and the conversations are scattered everywhere on your filesystem. Context is lost. Cost is invisible. History is buried.

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

<!-- repo-fact:agents:end -->

More agents coming soon. See the [extension checklist](#extending).

---

## Quick Start

### Prerequisites

<!-- repo-fact:node-version:start -->

- Node.js 22+ for the published CLI and building from source

<!-- repo-fact:node-version:end -->

<!-- repo-fact:pnpm-version:start -->

- pnpm 11.20.0 for building from source

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
# Only show sessions active in the last 3 days
npx codesesh --days 3

# Show all sessions (no time limit)
npx codesesh --days 0

# Show sessions active after a specific date (overrides --days)
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
metadata — id, slug, title, directory, project identity, timestamps, token/cost stats and smart
tags. It does **not** include messages, tool calls, reasoning or file activity, so it is not a
backup of your history. Session content stays in each agent's own data directory.

### CLI Options Reference

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `4521` | HTTP server starting port; falls back to the next available port if busy |
| `--host` | — | `127.0.0.1` | HTTP server bind address; default is local-only, set explicitly (e.g. `0.0.0.0`) to expose on the network |
| `--remote-access` | — | `false` | Enable token-protected access for a non-loopback `--host`; anyone with the startup URL can read session data |
| `--tls-cert` | — | — | Path to a TLS certificate; serves remote access over HTTPS |
| `--tls-key` | — | — | Path to the private key matching `--tls-cert` |
| `--trust-proxy` | — | `false` | A reverse proxy in front of CodeSesh terminates TLS |
| `--days` | `-d` | `7` | Only include sessions active in the last N days (`0` = all time) |
| `--cwd` | — | — | Filter to sessions from a project directory (`.` = current dir) |
| `--agent` | `-a` | all | Filter to specific agent(s), comma-separated |
| `--from` | — | — | Sessions active after this date `YYYY-MM-DD` (overrides `--days`) |
| `--to` | — | — | Sessions active before this date `YYYY-MM-DD` |
| `--session` | `-s` | — | Directly open a session (`agent://session-id`) |
| `--json` | `-j` | `false` | Print the session index as JSON and exit (metadata only, no messages) |
| `--no-open` | — | `false` | Don't auto-open the browser |
| `--trace` | — | `false` | Print performance trace logs |
| `--cache` | — | `true` | Use cached scan results when available |
| `--clear-cache` | — | `false` | Clear scan cache before starting |
| `-v` | — | — | Print version number |
| `-h` / `--help` | — | — | Show help |

Non-loopback binding and `--trust-proxy` are rejected unless `--remote-access` is also present.
This includes a loopback listener exposed by a same-machine reverse proxy. CodeSesh generates a new
access token for every process and includes it in the printed startup URL. Treat that URL as a
password: do not publish it or place it in shared shell history.

A token proves who is asking; it does not hide the answer. Without TLS the token and the full
session content travel the network in the clear, and the token in the URL can end up in reverse
proxy access logs. Pick one of:

```bash
# CodeSesh terminates TLS
npx codesesh --host 0.0.0.0 --remote-access --tls-cert ./cert.pem --tls-key ./key.pem

# A reverse proxy terminates TLS; CodeSesh stays bound to loopback
npx codesesh --host 127.0.0.1 --remote-access --trust-proxy
```

`--trust-proxy` requires every API request to arrive with `X-Forwarded-Proto: https`, and refuses
it otherwise — so a request that bypassed the proxy is rejected before authentication. This assumes
the deployment makes CodeSesh unreachable except through that proxy.

Using `--remote-access` without either TLS option still starts on a non-loopback address and prints
a warning that the transport is unencrypted.

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

```
packages/core       Core library (framework-agnostic)
  agents/           Agent adapters, registry, and registration
  analytics/        Dashboard aggregation
  contract/         Browser-safe types and shared pure logic
  discovery/        Session scanning, SQLite cache, and search index
  pricing/          Model price registry and cost estimation
  projects/         Project identity resolution
  search/           Session search across sources
  state/            Bookmarks, aliases, and preferences
  types/            Shared TypeScript types
  utils/            Utility functions

packages/cli        CLI entry point & HTTP server
  api/              Hono routes and request handlers
  *-worker.ts       Scan, search-index and smart-tag worker threads

apps/web            React frontend
  components/       UI components
  hooks/            Data loading and interaction hooks
  lib/              API client & utilities
```

`docs/architecture.md` describes how a scan flows through these; `docs/sqlite-storage.md` covers
the cache and search index; `docs/performance.md` describes what guards performance and where to add
a new guard.

### Extending

Agent capabilities have one registration point:

1. Create `packages/core/src/agents/<youragent>.ts`, implement `BaseAgent`, and export its data-root resolver.
2. Register it in `packages/core/src/agents/register.ts`, explicitly declaring its icon, data root, resume command support (`null` when unsupported), and whether it uses a custom or default tool display strategy.
3. Add its SVG to `apps/web/public/icon/agent/`.
4. For a custom tool display strategy, add `apps/web/src/components/session-detail/tool-strategy/<youragent>.ts` and register its builder in that directory's `index.ts`.

The registration completeness test rejects missing icons, undeclared resume support, and custom strategy mismatches.
