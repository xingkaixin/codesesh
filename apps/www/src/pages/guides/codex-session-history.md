---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: codex-session-history
---

Codex stores active local session transcripts as `rollout-*.jsonl` files in date folders under `~/.codex/sessions/YYYY/MM/DD/`, keeps thread titles in `~/.codex/session_index.jsonl`, and moves archived conversations into `~/.codex/archived_sessions/`. To reopen a thread in the CLI, run `codex resume` or `codex resume --last`. To browse, search, and replay Codex sessions across repositories in a local Web UI, run `npx codesesh --agent codex --days 0`.

## Codex sessions folder layout

By default, Codex keeps its local files under `~/.codex/` (`~` is your home directory). If you set `CODEX_HOME`, Codex and CodeSesh read from that directory instead.

- **Active transcripts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`):** Each file is a JSONL transcript containing prompts, responses, reasoning, shell commands, patches, and token usage.
- **Session title index (`~/.codex/session_index.jsonl`):** Maps thread IDs to display titles (`thread_name`). CodeSesh reads this index so renamed or titled Codex threads keep their names in search and lists.
- **Archived threads (`~/.codex/archived_sessions/`):** Holds sessions you archived in Codex. The current CodeSesh Codex adapter scans `sessions/` only and does not scan `archived_sessions/` by default.

Keep original JSONL files unchanged if you open them directly in an editor.

## List and resume Codex sessions from the terminal

Codex includes built-in resume commands for returning to recent threads directly in your terminal.

Open the interactive session list and pick a thread to resume:

```sh
codex resume
```

Jump straight back into your most recent session:

```sh
codex resume --last
```

Resume a specific session by ID (for example, copied from CodeSesh or from a `rollout-*.jsonl` record):

```sh
codex resume <session-id>
```

## Browse and search Codex history with CodeSesh

Because Codex organizes `rollout-*.jsonl` files by date rather than by repository, finding an older conversation across multiple projects takes manual grep or guesswork. CodeSesh acts as a local Codex session viewer: it parses each rollout file, groups sessions by repository identity, preserves nested subagent sessions, and indexes messages, command output, and touched file paths into SQLite.

Start CodeSesh for all local Codex history:

```sh
npx codesesh --agent codex --days 0
```

Limit the view to your current repository:

```sh
npx codesesh --agent codex --days 0 --cwd .
```

In the Web UI at `http://localhost:4521`, you can:

- **Search across repositories:** Find prompts, assistant replies, shell output, and file paths without remembering which date folder holds the `rollout-*.jsonl` file.
- **Replay tool calls and patches:** Inspect commands, diffs, and reasoning steps in chronological order.
- **Check tokens and estimated cost:** Review token totals and cache hits per session, project, or model. See the [usage and costs guide](/guides/usage-and-costs/) for how recorded and estimated costs work.
- **Resume immediately:** Copy the exact `codex resume <session-id>` command (including worktree path awareness) from any session detail page.

## Troubleshoot missing Codex sessions

- **Check `archived_sessions/`.** If you archived a thread in Codex, it moved out of `~/.codex/sessions/` into `~/.codex/archived_sessions/`, which CodeSesh does not scan by default.
- **Pass `--days 0`.** Plain `npx codesesh` defaults to the last 7 local calendar days. Use `--days 0` or switch the UI time range to All to see older rollout files.
- **Match `CODEX_HOME`.** Make sure the terminal launching CodeSesh exports the same `CODEX_HOME` value used when running Codex.
- **Allow initial backfill to finish.** Large histories index in the background on first launch; wait for indexing to complete before searching older message text.

If you also use Claude Code or other agents, see the [Claude Code session history guide](/guides/claude-code-session-history/) and the [cross-agent session history overview](/guides/session-history/). For standalone binary installation, see [getting started](/guides/getting-started/).
