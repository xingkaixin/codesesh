---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: claude-code-session-history
---

Claude Code stores full local session transcripts as JSONL files under `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`, and keeps a separate terminal prompt log in `~/.claude/history.jsonl`. To reopen a previous conversation in the terminal, run `claude --continue` or `claude --resume`. To search older conversations, tool outputs, and touched files across all projects, run `npx codesesh --agent claudecode --days 0`.

## Where Claude Code stores session files

By default, Claude Code writes its local state under `~/.claude/` (`~` is your home directory). If you set `CLAUDE_CONFIG_DIR`, every path below moves under that root instead.

- **Full session transcripts (`~/.claude/projects/<project>/<session-id>.jsonl`):** One JSON object per line covering user prompts, assistant responses, thinking blocks, tool calls, tool results, and token usage. Claude Code encodes each working directory path into a folder name under `projects/`.
- **Subagent transcripts (`<session>/subagents/*.jsonl`):** When Claude Code spawns subagents or workflow runs, their JSONL transcripts and `.meta.json` files live under the parent session directory. CodeSesh nests these child sessions under the parent conversation.
- **Prompt history (`~/.claude/history.jsonl`):** Stores your input history and timestamps for quick terminal recall. It does not contain assistant replies or tool output.

Because `history.jsonl` only tracks prompts you typed, always look inside `~/.claude/projects/` when you need the actual code changes, error output, or reasoning from a past session.

## List and open previous sessions in Claude Code

If you are already inside the project directory where a session started, Claude Code's built-in CLI flags are the fastest way to jump back in.

Continue the most recent session in the current directory:

```sh
claude --continue
```

Open an interactive picker to browse and resume past sessions:

```sh
claude --resume
```

Jump directly to a specific session ID (for example, one copied from CodeSesh or a JSONL filename):

```sh
claude --resume <session-id>
```

Inside an active Claude Code terminal session, you can also type `/resume` to switch conversations without exiting.

## Why old or archived Claude Code sessions disappear

If a conversation from last month is missing from `claude --resume` or from `~/.claude/projects/`, check these common causes first:

- **Automatic local cleanup (`cleanupPeriodDays`):** Claude Code deletes local transcript files older than its configured `cleanupPeriodDays` in `~/.claude/settings.json` (30 days by default). Once Claude Code removes a JSONL file from disk, neither Claude Code nor CodeSesh can recover it unless you already have a backup or an existing CodeSesh SQLite index from before deletion.
- **Different working directory or git worktree:** Claude Code scopes session directories by project path. Running `claude --resume` from a parent folder or a different worktree hides sessions recorded under another path.
- **Custom `CLAUDE_CONFIG_DIR`:** Sessions created with a separate profile or environment variable live under that custom directory rather than `~/.claude/projects/`.

## Search and replay Claude Code history with CodeSesh

When you need to find a conversation across repositories, search tool output, or trace which session edited a specific file, native CLI pickers are not enough. CodeSesh indexes your local `~/.claude/projects/` JSONL transcripts into SQLite and opens a read-only Web UI on localhost.

Scan all local Claude Code sessions (not just the default 7-day window):

```sh
npx codesesh --agent claudecode --days 0
```

To inspect only the current repository:

```sh
npx codesesh --agent claudecode --days 0 --cwd .
```

In the Web UI, you can:

- **Search across projects:** Match user messages, assistant replies, tool outputs, and file paths in one query, then jump directly to the matching message inside the replay timeline.
- **Inspect nested subagents:** View parent and child agent runs together with rolled-up token usage and estimated costs.
- **Track file activity:** Look up a path such as `src/auth.ts` to find every Claude Code session that read, edited, or created it.
- **Copy worktree-aware resume commands:** Click copy on any session detail page to get the exact `claude --resume <session-id>` command for that workspace.

If you use both Claude Code and Codex, see the [Codex session history guide](/guides/codex-session-history/) or the [cross-agent session history overview](/guides/session-history/). For installation options without Node.js, see [getting started](/guides/getting-started/).

## Preserve transcripts safely

CodeSesh never modifies or deletes your `~/.claude/projects/` files. If you want to keep Claude Code transcripts beyond the default retention period, increase `cleanupPeriodDays` in `~/.claude/settings.json` and back up `~/.claude/projects/` directly.
