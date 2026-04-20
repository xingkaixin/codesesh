# CodeSesh

> **One place to see every AI coding session you've ever had.**

You've been coding with AI agents — Claude Code, Cursor, Kimi, Codex, OpenCode — and the conversations are scattered everywhere on your filesystem. Context is lost. Cost is invisible. History is buried.

**CodeSesh** fixes that. It scans your local machine, finds every AI agent session, and surfaces them in a unified, beautiful Web UI. Think of it as a time machine for your AI-assisted development workflow.

---

## Why CodeSesh?

Modern developers work with multiple AI coding agents simultaneously. Each tool stores its session history in its own proprietary format, in its own hidden directory. There's no way to search across them, compare costs, or revisit that brilliant conversation you had three weeks ago.

CodeSesh believes your session history belongs to **you** — and you deserve to see it all in one place.

**What you get:**

- **Unified Timeline** — Browse sessions across all your AI agents in a single, searchable interface
- **Dashboard & Activity Trends** — Track daily activity, agent distribution, recent sessions, and latest activity at a glance
- **Full Conversation Replay** — Read every message, tool call, and reasoning step exactly as it happened
- **Cost & Token Visibility** — See exactly how many tokens and dollars each session consumed
- **Zero Configuration** — Just run it. CodeSesh auto-discovers everything on your filesystem
- **100% Local & Private** — Nothing leaves your machine. No accounts, no cloud sync, no telemetry
- **Live Refresh** — File changes are picked up automatically, and the UI stays in sync without a restart

---

## Supported Agents

| Agent | Status |
|-------|--------|
| Claude Code | Supported |
| Cursor | Supported |
| Kimi | Supported |
| Codex | Supported |
| OpenCode | Supported |

More agents coming soon. Adding a new one is [a single file](#extending).

---

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 10+

### Install & Run

```bash
# Clone the repo
git clone https://github.com/your-username/codesesh.git
cd codesesh

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Launch — scans sessions and opens your browser
npx codesesh serve
```

That's it. Your browser will open at `http://localhost:4321` with all your sessions ready to browse.

---

## Usage

### Basic Usage

```bash
# Start the web UI (default port 4321)
npx codesesh

# Choose a custom port
npx codesesh --port 8080
npx codesesh -p 8080

# Start without auto-opening the browser
npx codesesh --no-open
```

### Filter by Time

```bash
# Only show sessions from the last 3 days
npx codesesh --days 3

# Show all sessions (no time limit)
npx codesesh --days 0

# Show sessions after a specific date (overrides --days)
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
# Dump all session data as JSON instead of starting the server
npx codesesh --json
npx codesesh -j
```

### CLI Options Reference

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `4321` | HTTP server port |
| `--days` | `-d` | `7` | Only include sessions from the last N days (`0` = all time) |
| `--cwd` | — | — | Filter to sessions from a project directory (`.` = current dir) |
| `--agent` | `-a` | all | Filter to specific agent(s), comma-separated |
| `--from` | — | — | Sessions created after this date `YYYY-MM-DD` (overrides `--days`) |
| `--to` | — | — | Sessions created before this date `YYYY-MM-DD` |
| `--session` | `-s` | — | Directly open a session (`agent://session-id`) |
| `--json` | `-j` | `false` | Output JSON and exit (no server) |
| `--no-open` | — | `false` | Don't auto-open the browser |
| `--trace` | — | `false` | Print performance trace logs |
| `--cache` | — | `true` | Use cached scan results when available |
| `--clear-cache` | — | `false` | Clear scan cache before starting |
| `-v` | — | — | Print version number |
| `-h` / `--help` | — | — | Show help |

---

## Web UI Walkthrough

Once CodeSesh is running, here's what you'll find:

1. **Dashboard** — Start from a summary view with total sessions, total messages, total tokens, latest activity, daily activity, agent distribution, and recent sessions.
2. **Agent Sidebar** — A panel listing all detected agents with session counts. Click any agent to filter the view.
3. **Session List** — Browse your sessions sorted by most recent. Each card shows the session title, working directory, message count, and total cost at a glance.
4. **Session Detail** — Click any session to open a full replay. You'll see every user message, assistant response, tool invocation, and reasoning step exactly as it unfolded.
5. **Live Updates** — New or changed local sessions are reflected automatically while the server is running.

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

# Deploy landing page to Cloudflare Pages
pnpm --filter @codesesh/www deploy:cf
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
  agents/           Agent adapters (one file per agent)
  discovery/        Session path resolution & file scanning
  types/            Shared TypeScript types
  utils/            Utility functions

packages/cli        CLI entry point & HTTP server
  src/commands/     CLI subcommands
  src/api/          Hono route handlers

apps/web            React frontend
  src/components/   UI components
  src/lib/          API client & utilities
```

### Extending

Adding support for a new AI agent takes one file:

1. Create `packages/core/src/agents/youragent.ts` implementing `BaseAgent`
2. Register it in `packages/core/src/agents/register.ts`

No other files need to change. The agent immediately appears in the UI.
