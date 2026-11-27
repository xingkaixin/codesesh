---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: opencode-session-history
---

OpenCode stores local session history in an SQLite database at `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/opencode.db`), overridable via `OPENCODE_DB`. To reopen a session in the terminal, run `opencode -s <session-id>`. To search prompts, tool output, file changes, and recorded costs across repositories in a local Web UI, run `npx codesesh --agent opencode --days 0`.

## Where OpenCode stores its session database

By default, OpenCode writes sessions, messages, tool calls, reasoning steps, and cost metadata into one local SQLite file:

- **Default database path:** `~/.local/share/opencode/opencode.db`
- **XDG override:** `$XDG_DATA_HOME/opencode/opencode.db` when `XDG_DATA_HOME` is set
- **Direct override:** `OPENCODE_DB` (either an absolute path or a filename relative to the OpenCode data directory; `:memory:` databases are skipped)

CodeSesh supports OpenCode V1 (`session`) and V2 (`session_v2` / `session_message`) database layouts, including databases mid-way through a V1-to-V2 migration.

## Resume an OpenCode session from the terminal

When you already know which session you want to continue, OpenCode's CLI accepts the session ID directly:

```sh
opencode -s <session-id>
```

You can copy the exact `opencode -s <session-id>` command (with working directory context) from any OpenCode session detail page inside CodeSesh.

## Browse and search OpenCode history with CodeSesh

Because OpenCode stores conversations inside SQLite, searching across repositories for an error trace, a shell command, or a file edit requires querying the database directly. CodeSesh opens `opencode.db` read-only and indexes every conversation into a fast local Web UI.

Scan all local OpenCode sessions:

```sh
npx codesesh --agent opencode --days 0
```

Focus on the current repository:

```sh
npx codesesh --agent opencode --days 0 --cwd .
```

In the Web UI at `http://localhost:4521`, you can:

- **Search messages and tool output:** Filter across projects, smart tags, and touched file paths in one query.
- **Inspect nested subagent sessions:** Keep child sessions grouped under their parent task with rolled-up token totals.
- **Review recorded costs and reasoning:** OpenCode records token usage and costs directly, which CodeSesh displays alongside full reasoning and tool-call timelines.
- **Copy resume commands:** Jump back into the terminal with `opencode -s <session-id>` whenever you find the right context.

## Troubleshoot missing OpenCode sessions

- **Match `OPENCODE_DB` and `XDG_DATA_HOME`.** Start CodeSesh from a shell that exports the same environment variables OpenCode uses.
- **Pass `--days 0`.** Plain `npx codesesh` defaults to the last 7 local calendar days; use `--days 0` or switch the UI window to All for older sessions.
- **Check in-memory mode.** If `OPENCODE_DB` is set to `:memory:`, sessions are not persisted on disk and cannot be indexed.

See also the [Claude Code session history guide](/guides/claude-code-session-history/), [Codex session history guide](/guides/codex-session-history/), and [token usage and costs guide](/guides/usage-and-costs/).
