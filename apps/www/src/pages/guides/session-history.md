---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: session-history
---

Most local AI coding agents store session history in hidden JSONL directories or SQLite databases under your home directory. Claude Code writes transcripts to `~/.claude/projects/` (and prompt history to `~/.claude/history.jsonl`), Codex writes `rollout-*.jsonl` files under `~/.codex/sessions/`, and tools like Cursor, OpenCode, and Gemini CLI each keep separate stores. CodeSesh indexes these local locations into one searchable Web UI without uploading your data.

For tool-specific commands, directory layouts, and retention rules, read the dedicated guides for [Claude Code](/guides/claude-code-session-history/), [Codex](/guides/codex-session-history/), [Cursor](/guides/cursor-session-history/), [OpenCode](/guides/opencode-session-history/), and [Gemini CLI](/guides/gemini-cli-session-history/).

## Default local storage locations

`~` refers to your user home directory. CodeSesh reads these locations by default when scanning local agents:

| Agent       | Default history path                                                                                                    | Environment override            | Native resume     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------- |
| Claude Code | `~/.claude/projects/`                                                                                                   | `CLAUDE_CONFIG_DIR`             | `claude --resume` |
| Codex       | `~/.codex/sessions/`                                                                                                    | `CODEX_HOME`                    | `codex resume`    |
| Cursor      | `~/Library/Application Support/Cursor/User` (macOS), `~/.config/Cursor/User` (Linux), `%APPDATA%\Cursor\User` (Windows) | `CURSOR_DATA_PATH`              | —                 |
| OpenCode    | `~/.local/share/opencode/opencode.db`                                                                                   | `OPENCODE_DB` / `XDG_DATA_HOME` | `opencode -s`     |
| Gemini CLI  | `~/.gemini/tmp/`                                                                                                        | `GEMINI_CLI_HOME`               | `gemini --resume` |
| Droid       | `~/.factory/sessions/`                                                                                                  | `FACTORY_HOME_OVERRIDE`         | `droid --resume`  |
| Pi          | `~/.pi/agent/sessions/`                                                                                                 | `PI_CODING_AGENT_DIR`           | `pi --session`    |
| Antigravity | `~/.gemini/antigravity/conversations/`                                                                                  | `ANTIGRAVITY_CONVERSATIONS_DIR` | —                 |

Start CodeSesh from a terminal that has the same environment variables as your coding tool. Variables such as `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point to the tool's root directory, not directly to `projects/` or `sessions/`.

Two common caveats apply across these stores:

- **Codex archives:** The current Codex adapter scans `~/.codex/sessions/` and does not scan `~/.codex/archived_sessions/` by default.
- **Claude Code prompt log vs. full transcripts:** `~/.claude/history.jsonl` stores terminal prompt history; full replies, tool calls, and subagent runs live under `~/.claude/projects/`.

## Native CLI resume vs. cross-project search

Native commands such as `claude --resume` and `codex resume` work well when you are already in the right repository and want to continue a recent thread. They break down when you only remember a file path, an error message, or a fix you made weeks ago in another tool.

You can inspect raw JSONL files in a text editor without installing a viewer, though each transcript contains many structured tool events and metadata lines. Keep original files unmodified when inspecting them.

## Search and replay history with CodeSesh

CodeSesh indexes supported local records into one local SQLite database so you can search messages, tool output, and file paths across projects and agents. Standalone mode requires no account and keeps everything on your computer. See the [installation guide](/guides/getting-started/) for standalone binaries and other installation options.

With Node.js 22 or later, start a full-history scan in a terminal:

```sh
npx codesesh --days 0
```

CodeSesh opens its Web UI at `http://localhost:4521` (or the next free port printed in the terminal). Keep the process running while you browse.

**Why `--days 0`?** Plain `npx codesesh` opens with sessions active in the last seven local calendar days so startup stays fast. Pass `--days 0` when searching older history.

## Narrow search by project, agent, or file

Suppose you fixed a login timeout in `my-app` weeks ago, but cannot remember whether you used Claude Code or Codex:

1. Open global search and enter a distinctive phrase from the conversation or error output.
2. Narrow results with the project filter, agent filter, or smart tag filter.
3. If you do not remember the exact wording, search a file path such as `src/auth.ts` or check the file activity index to list every session that read or edited that file.
4. Open a matching session to read messages, tool calls, and reasoning in sequence, then copy the agent's resume command if you want to pick up where you left off.

Scope the server to the current repository before starting:

```sh
npx codesesh --days 0 --cwd .
```

Or scan only Claude Code and Codex:

```sh
npx codesesh --days 0 --agent claudecode,codex
```

Replay reads recorded conversations and tool output without re-running commands or modifying files. See the [search and replay product demo](/#tour) for an interface preview, or read [token usage and costs](/guides/usage-and-costs/) to inspect spend across sessions.

<span id="troubleshooting"></span>

## Troubleshoot missing sessions

- **Check the time window.** Restart with `--days 0` or switch the UI range from 7 days to All. Remove restrictive `--from`, `--to`, `--cwd`, or `--agent` flags.
- **Check retention and archive directories.** Claude Code deletes old local transcripts after `cleanupPeriodDays` (30 days by default), and Codex moves archived threads to `~/.codex/archived_sessions/`.
- **Check environment variables.** Confirm `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or other custom data roots are exported in the same shell that runs CodeSesh.
- **Wait for background indexing.** Initial backfill builds the search index in the background, so newly discovered older sessions may appear in the list before their full message text is searchable.
- **Report reproducible parser issues.** If supported files exist and are readable but still do not appear, [open an issue](https://github.com/xingkaixin/codesesh/issues) with your CodeSesh version, agent name, and redacted error details.

## Know what the local index preserves

CodeSesh is a read-only viewer and search index, not a backup tool. It retains sessions already stored in its SQLite index if a source temporarily disappears, but it cannot recover files deleted before scanning. Its `--json` output emits session metadata rather than a full transcript archive.

Keep your agent data directories backed up if you need long-term retention. To export sessions from Claude Code, Codex, or Cursor into standalone files for sharing, pair CodeSesh with [Agent Dump](https://agent-dump.xingkaixin.me/). For the complete list of supported tools, return to the [CodeSesh overview](/).
