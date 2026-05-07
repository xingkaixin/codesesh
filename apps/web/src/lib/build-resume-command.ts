/**
 * Builds the shell command a user would paste into their terminal to resume
 * an AI coding session locally. Used by the "copy resume command" button in
 * the session detail header.
 *
 * Always uses `session.directory` (the SessionHead field) for `cd` rather
 * than e.g. `project_identity.path_root`, because `directory` reflects the
 * actual cwd at session start — including git worktree paths — which is the
 * one a `--resume` invocation needs to find the same context. Falsy or empty
 * directories degrade gracefully to a no-cd command instead of producing
 * something like `cd '' && ...`.
 */

/** POSIX single-quote escape: wraps in '...' and escapes embedded ' as '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface BuildResumeCommandInput {
  sessionId: string;
  directory?: string | null;
}

export function buildResumeCommand({ sessionId, directory }: BuildResumeCommandInput): string {
  const quotedId = shellQuote(sessionId);
  const trimmed = directory?.trim();
  if (!trimmed) {
    return `claude --resume ${quotedId}`;
  }
  return `cd ${shellQuote(trimmed)} && claude --resume ${quotedId}`;
}
