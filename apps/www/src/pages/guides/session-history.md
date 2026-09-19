---
layout: ../../layouts/SessionHistoryLayout.astro
locale: en
---

Use CodeSesh to search and replay Claude Code and Codex conversations that are still stored on your computer. It reads supported local records, groups sessions by project, and lets you search messages, tool output, and file paths. You do not need to upload your history or create an account.

## 1. Start the local viewer

Install Node.js 22 or later, then run this in a terminal:

```sh
npx codesesh --days 0
```

CodeSesh opens its Web UI at `http://localhost:4521`. If that port is occupied, use the address printed in the terminal. Keep the terminal process running while you browse.

**Why `--days 0`?** The default command, `npx codesesh`, includes sessions active in the last seven local calendar days. Use `--days 0` when you want to find older conversations. A large history may take time to finish its first scan and search indexing.

## 2. Check where your history is stored

CodeSesh reads these locations by default. `~` means your user home directory:

- **Claude Code:** JSONL session records under `~/.claude/projects/`. If you set `CLAUDE_CONFIG_DIR`, CodeSesh reads the `projects/` directory under that configuration root.
- **Codex:** `rollout-*.jsonl` records under `~/.codex/sessions/`, including nested date directories. If you set `CODEX_HOME`, CodeSesh reads `sessions/` under that root.

Start CodeSesh from a terminal that has the same environment variables as your coding tool. These variables point to the tool's root directory, not directly to `projects/` or `sessions/`.

The current Codex adapter does not scan `~/.codex/archived_sessions/` by default. Conversations stored only on another computer or in a hosted service are outside this local scan.

## 3. Find a conversation by project and content

Suppose you remember fixing a login timeout in the `my-app` repository, but cannot remember whether you used Claude Code or Codex:

1. Open global search and enter a distinctive phrase from the conversation, such as `login timeout`. Use words that actually appeared in your records; this is a search example, not bundled session data.
2. Narrow the results with the project filter. If you remember the tool, also select Claude Code or Codex in the agent filter.
3. If the wording is unclear, try a file path such as `src/auth.ts`. Search can match indexed file paths and tool output as well as conversation text.
4. Open a matching session. Read the surrounding messages and expand tool calls to recover the reasoning and recorded output. Use the file activity view to locate files that were read or changed.

You can also scope the server to one project from its directory:

```sh
npx codesesh --days 0 --cwd .
```

Or include only these two agents:

```sh
npx codesesh --days 0 --agent claudecode,codex
```

Replay means reading the recorded conversation and tool activity. It does not rerun commands or restore an earlier filesystem state. See the [search and replay product demo](/#tour) for the interface overview.

<h2 id="troubleshooting">4. If a session is missing</h2>

- **Check the time range first.** Restart with `--days 0` and clear restrictive filters in the UI. Remove `--from`, `--to`, `--cwd`, or `--agent` options if they exclude the session.
- **Check the source files.** Confirm the records still exist under the relevant local directory and that the current user can read them. For Codex, check whether the session was moved to `archived_sessions/`.
- **Check custom roots.** Make sure `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is present in the terminal launching CodeSesh, especially if the coding tool was launched from a different shell or app.
- **Allow indexing to finish.** The initial backfill and search index run in the background. A session list appearing does not mean all older message content is already searchable.
- **Report a reproducible parsing problem.** If supported records exist but still do not appear, [open an issue](https://github.com/xingkaixin/codesesh/issues) with the CodeSesh version, agent, and relevant error. Remove private prompts, paths, and credentials from anything you share.

## 5. Know what the local index preserves

CodeSesh is a viewer and search index, not a backup of the original conversation files. It cannot recover history that has been deleted from the agent's storage. Its `--json` output contains session metadata, not a full archive of messages and tool calls.

Keep the original agent data if you need to retain your history. For other supported tools and product capabilities, return to the [CodeSesh overview](/).
