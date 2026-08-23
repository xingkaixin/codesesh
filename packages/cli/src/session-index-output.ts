/**
 * Shape of `--json`: an index of what exists, not an archive of what was said.
 *
 * Sessions are reported as heads — metadata only. Messages, tool calls,
 * reasoning and file activity stay in each agent's own data directory, so this
 * output is deliberately not a backup, and must not quietly grow into one.
 */
import {
  filterSessionTreeByActivityWindow,
  type IdentifiedSessionHead,
  type LiveSnapshot,
} from "@codesesh/core/runtime/discovery";
import { getAgentInfoMap } from "@codesesh/core/runtime/agents";

export interface SessionIndexAgent {
  name: string;
  displayName: string;
  count: number;
  available: boolean;
}

export interface SessionIndexOutput {
  agents: SessionIndexAgent[];
  sessions: IdentifiedSessionHead[];
}

export interface SessionIndexWindow {
  from?: number;
  to?: number;
}

export function formatScanFailureDiagnostics(
  snapshot: Pick<LiveSnapshot, "scanFailures">,
): string[] {
  return Object.values(snapshot.scanFailures ?? {}).map((failure) => {
    const source = failure.sourcePath ? ` at ${failure.sourcePath}` : "";
    return `[${failure.agentName}] Scan failed during ${failure.stage}${source} (${failure.errorClass}): ${failure.message}`;
  });
}

export function formatCacheFailureDiagnostics(
  snapshot: Pick<LiveSnapshot, "cacheFailures">,
): string[] {
  return Object.values(snapshot.cacheFailures ?? {}).map((failure) =>
    failure.operation === "read"
      ? `[${failure.agentName}] Cache read failed; durable baseline is unavailable`
      : `[${failure.agentName}] Cache persistence failed; serving in-memory results without advancing the durable baseline`,
  );
}

export function buildSessionIndexOutput(
  snapshot: Pick<LiveSnapshot, "sessions" | "byAgent">,
  window: SessionIndexWindow = {},
): SessionIndexOutput {
  // Keep --days/--from/--to meaningful for the JSON output too.
  const sessions = filterSessionTreeByActivityWindow(snapshot.sessions, window.from, window.to);

  const agents = getAgentInfoMap(
    Object.fromEntries(
      Object.entries(snapshot.byAgent).map(([name, list]) => [
        name,
        filterSessionTreeByActivityWindow(list, window.from, window.to).length,
      ]),
    ),
  ).map(({ name, displayName, count }) => ({
    name,
    displayName,
    count,
    available: count > 0,
  }));

  return { agents, sessions };
}
