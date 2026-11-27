---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: cursor-session-history
---

Cursor stores local Composer and chat history inside an SQLite database at `globalStorage/state.vscdb` under its user data directory (`~/Library/Application Support/Cursor/User` on macOS, `~/.config/Cursor/User` on Linux, and `%APPDATA%\Cursor\User` on Windows). To search, browse, and replay Cursor conversations across projects in a local Web UI without querying SQLite by hand, run `npx codesesh --agent cursor --days 0`.

## Where Cursor stores chat and Composer history

By default, Cursor keeps its local state in the OS-standard application data directory. If you export `CURSOR_DATA_PATH` pointing to your `Cursor/User` folder, CodeSesh reads from that directory instead.

- **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb` (or `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`)
- **Windows:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

Inside `state.vscdb`, Cursor writes Composer sessions and message bubbles to the `cursorDiskKV` table under `composerData:*`, `bubbleId:*`, and `bubble:*` keys. Because everything is stored as JSON blobs inside SQLite rather than plain Markdown or JSONL files, grep and file search cannot read it directly.

## Search and replay Cursor history with CodeSesh

Cursor lets you reopen chats inside the IDE, but searching across older workspaces, tracing tool outputs, or finding which conversation modified a specific file is difficult from the editor sidebar. CodeSesh opens `state.vscdb` in read-only mode, parses Composer sessions and tool calls, and builds a searchable local index on localhost.

Scan all local Cursor history:

```sh
npx codesesh --agent cursor --days 0
```

Limit the view to the current repository:

```sh
npx codesesh --agent cursor --days 0 --cwd .
```

In the Web UI at `http://localhost:4521`, you can:

- **Search across repositories:** Match prompts, assistant replies, tool outputs, and touched file paths across every Cursor workspace in one query.
- **Replay tool calls and edits:** Read messages and tool results in sequence without modifying `state.vscdb` or reopening old Cursor windows.
- **Combine with terminal agents:** Drop `--agent cursor` to browse Cursor history alongside Claude Code, Codex, OpenCode, and Gemini CLI in the same project tree.

Cursor is a desktop IDE and does not expose a CLI session resume flag, so CodeSesh displays history for reading and search without generating a terminal resume command.

## Troubleshoot missing Cursor chats

- **Pass `--days 0`.** Plain `npx codesesh` defaults to the last 7 local calendar days. Pass `--days 0` or switch the UI time range to All to view older Cursor conversations.
- **Check `CURSOR_DATA_PATH`.** If Cursor stores its user data in a custom profile or portable directory, export `CURSOR_DATA_PATH` pointing to the `User` directory that contains `globalStorage/state.vscdb`.
- **Check token and cost fields.** Cursor records partial token counts on some sessions; when model and token counts are present, CodeSesh estimates costs locally without uploading session content.

For terminal-based agents, see the [Claude Code session history guide](/guides/claude-code-session-history/), [Codex session history guide](/guides/codex-session-history/), or the [cross-agent session history overview](/guides/session-history/).

## Keep Cursor data safe

CodeSesh always opens `state.vscdb` in read-only mode and never writes to Cursor's database. If you want a long-term backup before reinstalling or clearing Cursor storage, close Cursor and copy the `Cursor/User/globalStorage/state.vscdb` file directly.
