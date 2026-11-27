---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: gemini-cli-session-history
---

Gemini CLI stores local conversation transcripts as JSON and JSONL files under `~/.gemini/tmp/<project-hash>/chats/`. If `GEMINI_CLI_HOME` is set, Gemini CLI and CodeSesh read from `$GEMINI_CLI_HOME/.gemini/tmp/` instead. To reopen a previous conversation in the terminal, run `gemini --resume`. To search conversations, tool calls, reasoning, and token usage across projects in a local Web UI, run `npx codesesh --agent gemini-cli --days 0`.

## Where Gemini CLI stores local chat history

By default, Gemini CLI writes per-project chat transcripts under your home directory:

- **Session files:** `~/.gemini/tmp/<project-hash>/chats/*.json` and `*.jsonl`
- **Custom root override:** Set `GEMINI_CLI_HOME` to override the parent directory of `.gemini/` (CodeSesh scans `$GEMINI_CLI_HOME/.gemini/tmp/`)

Because folders under `~/.gemini/tmp/` are keyed by project hashes rather than readable repository names, locating a specific past conversation manually in the filesystem is slow.

## Reopen a previous Gemini CLI session

When you are already inside the project directory, use Gemini CLI's built-in resume flag:

```sh
gemini --resume
```

If you have a specific session ID from CodeSesh, pass it directly to `gemini --resume <session-id>`.

## Search and replay Gemini CLI history with CodeSesh

CodeSesh scans `~/.gemini/tmp/*/chats/` read-only, resolves project identities, and builds a local SQLite index so you can search across hashed project folders without opening raw JSON files.

Scan all local Gemini CLI sessions:

```sh
npx codesesh --agent gemini-cli --days 0
```

Scope to the current repository:

```sh
npx codesesh --agent gemini-cli --days 0 --cwd .
```

In the Web UI at `http://localhost:4521`, you can:

- **Search across all projects:** Match prompts, Gemini replies, tool outputs, and touched file paths without hunting through hashed directories under `~/.gemini/tmp/`.
- **Replay reasoning and tool calls:** Inspect thought steps, tool arguments, and results in chronological order, including nested subagent sessions.
- **Inspect token usage and estimated cost:** Review input, output, reasoning, and cached tokens per project or model.
- **Copy resume commands:** Copy `gemini --resume <session-id>` directly from any session detail view.

## Troubleshoot missing Gemini CLI sessions

- **Check `GEMINI_CLI_HOME`.** Remember `GEMINI_CLI_HOME` points to the parent directory containing `.gemini/`, not directly to `.gemini/tmp/`.
- **Pass `--days 0`.** Plain `npx codesesh` opens with the last 7 local calendar days; pass `--days 0` or choose All in the UI for older chats.
- **Check temporary directory cleanup.** Because Gemini CLI stores chats under `~/.gemini/tmp/`, clearing that folder removes source records permanently. CodeSesh keeps already-indexed records if a source temporarily disappears, but cannot recover files deleted before scanning.

See also the [cross-agent session history overview](/guides/session-history/), [Claude Code session history guide](/guides/claude-code-session-history/), and [Codex session history guide](/guides/codex-session-history/).
