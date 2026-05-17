/**
 * Builds the shell command a user would paste into their terminal to resume
 * an AI coding session locally. Used by the "copy resume command" button in
 * the session detail header.
 *
 * Always uses `session.directory` (the SessionHead field) for `cd` rather
 * than e.g. `project_identity.path_root`, because `directory` reflects the
 * actual cwd at session start — including git worktree paths — which is the
 * one a resume invocation needs to find the same context. Falsy or empty
 * directories degrade gracefully to a no-cd command instead of producing
 * something like `cd '' && ...`.
 */

/** POSIX single-quote escape: wraps in '...' and escapes embedded ' as '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const RESUME_COMMAND_PREFIX_BY_AGENT = {
  claudecode: "claude --resume",
  codex: "codex resume",
  kimi: "kimi -r",
  opencode: "opencode -s",
} as const;

type ResumeAgentKey = keyof typeof RESUME_COMMAND_PREFIX_BY_AGENT;

export interface BuildResumeCommandInput {
  agentName: string;
  sessionId: string;
  directory?: string | null;
}

function getResumeCommandPrefix(agentName: string) {
  const key = agentName.toLowerCase();
  if (!(key in RESUME_COMMAND_PREFIX_BY_AGENT)) return null;
  return RESUME_COMMAND_PREFIX_BY_AGENT[key as ResumeAgentKey];
}

export function buildResumeCommand({
  agentName,
  sessionId,
  directory,
}: BuildResumeCommandInput): string | null {
  const prefix = getResumeCommandPrefix(agentName);
  if (!prefix) return null;

  const invocation = `${prefix} ${shellQuote(sessionId)}`;
  const raw = directory ?? "";
  // Use trim() only to detect "effectively empty" — don't lose surrounding
  // whitespace from the actual cd argument. The shellQuote'd path must match
  // the directory string verbatim so a path like " /tmp/proj " (a quirky but
  // legitimate cwd) still resolves correctly when pasted into the shell.
  if (!raw.trim()) {
    return invocation;
  }
  return `cd ${shellQuote(raw)} && ${invocation}`;
}
