/**
 * Shape of `--json`: an index of what exists, not an archive of what was said.
 *
 * Sessions are reported as heads — metadata only. Messages, tool calls,
 * reasoning and file activity stay in each agent's own data directory, so this
 * output is deliberately not a backup, and must not quietly grow into one.
 */
import { getAgentInfoMap, type LiveSnapshot, type SessionHead } from "@codesesh/core";

export interface SessionIndexAgent {
  name: string;
  displayName: string;
  count: number;
  available: boolean;
}

export interface SessionIndexOutput {
  agents: SessionIndexAgent[];
  sessions: SessionHead[];
}

export interface SessionIndexWindow {
  from?: number;
  to?: number;
}

export function buildSessionIndexOutput(
  snapshot: Pick<LiveSnapshot, "sessions" | "byAgent">,
  window: SessionIndexWindow = {},
): SessionIndexOutput {
  // Keep --days/--from/--to meaningful for the JSON output too.
  const sessions = snapshot.sessions.filter((session) => {
    const activity = session.time_updated ?? session.time_created;
    if (window.from != null && activity < window.from) return false;
    if (window.to != null && activity > window.to) return false;
    return true;
  });

  const agents = getAgentInfoMap(
    Object.fromEntries(Object.entries(snapshot.byAgent).map(([name, list]) => [name, list.length])),
  ).map(({ name, displayName, count }) => ({
    name,
    displayName,
    count,
    available: count > 0,
  }));

  return { agents, sessions };
}
