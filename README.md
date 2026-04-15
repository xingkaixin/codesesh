# Agent Lens

> **One place to see every AI coding session you've ever had.**

You've been coding with AI agents — Claude Code, Cursor, Kimi, Codex, OpenCode — and the conversations are scattered everywhere on your filesystem. Context is lost. Cost is invisible. History is buried.

**Agent Lens** fixes that. It scans your local machine, finds every AI agent session, and surfaces them in a unified, beautiful Web UI. Think of it as a time machine for your AI-assisted development workflow.

---

## Why Agent Lens?

Modern developers work with multiple AI coding agents simultaneously. Each tool stores its session history in its own proprietary format, in its own hidden directory. There's no way to search across them, compare costs, or revisit that brilliant conversation you had three weeks ago.

Agent Lens believes your session history belongs to **you** — and you deserve to see it all in one place.

**What you get:**

- **Unified Timeline** — Browse sessions across all your AI agents in a single, searchable interface
- **Full Conversation Replay** — Read every message, tool call, and reasoning step exactly as it happened
- **Cost & Token Visibility** — See exactly how many tokens and dollars each session consumed
- **Zero Configuration** — Just run it. Agent Lens auto-discovers everything on your filesystem
- **100% Local & Private** — Nothing leaves your machine. No accounts, no cloud sync, no telemetry
- **Instant Startup** — Scans and launches in seconds, then opens your browser automatically

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
- pnpm 9+

### Install & Run

```bash
# Clone the repo
git clone https://github.com/your-username/agent-lens.git
cd agent-lens

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Launch — scans sessions and opens your browser
npx agent-lens serve
```

That's it. Your browser will open at `http://localhost:4321` with all your sessions ready to browse.

---

## Usage

### Basic Usage

```bash
# Start the web UI (default port 4321)
npx agent-lens serve

# Choose a custom port
npx agent-lens serve --port 8080
npx agent-lens serve -p 8080

# Start without auto-opening the browser
npx agent-lens serve --no-open
```

### Filter by Agent

```bash
# Only show Claude Code sessions
npx agent-lens serve --agent claudecode

# Only show Cursor sessions
npx agent-lens serve --agent cursor
```

### JSON Output (for scripting)

```bash
# Dump all session data as JSON instead of starting the server
npx agent-lens serve --json
npx agent-lens serve -j
```

### CLI Options Reference

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `4321` | HTTP server port |
| `--agent` | `-a` | all | Filter to a specific agent |
| `--json` | `-j` | `false` | Output JSON and exit (no server) |
| `--no-open` | — | `false` | Don't auto-open the browser |

---

## Web UI Walkthrough

Once Agent Lens is running, here's what you'll find:

1. **Agent Sidebar** — A panel listing all detected agents with session counts. Click any agent to filter the view.

2. **Session List** — Browse your sessions sorted by most recent. Each card shows the session title, working directory, message count, and total cost at a glance.

3. **Session Detail** — Click any session to open a full replay. You'll see every user message, assistant response, tool invocation, and reasoning step — exactly as it unfolded.

4. **Stats Bar** — At the top of each session, see the total tokens consumed (input + output) and the cost in dollars.

---

## Development

```bash
# Run everything in dev mode (hot reload)
pnpm dev

# Build all packages
pnpm build

# Clean build artifacts
pnpm clean
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
