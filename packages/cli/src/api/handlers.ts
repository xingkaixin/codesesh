import type { Context } from "hono";
import type { ScanResult, SessionData, SessionHead } from "@codesesh/core";
import { getAgentInfoMap } from "@codesesh/core";

export interface ScanResultSource {
  getSnapshot(): ScanResult;
}

export function handleGetAgents(c: Context, scanSource: ScanResultSource) {
  const scanResult = scanSource.getSnapshot();
  const counts = Object.fromEntries(
    Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [agentName, sessions.length]),
  );
  const info = getAgentInfoMap(counts);
  return c.json(info);
}

export function handleGetSessions(c: Context, scanSource: ScanResultSource) {
  const scanResult = scanSource.getSnapshot();
  const agent = c.req.query("agent");
  const q = c.req.query("q")?.toLowerCase();
  const cwd = c.req.query("cwd")?.toLowerCase();
  const from = c.req.query("from");
  const to = c.req.query("to");

  let sessions: SessionHead[] = [];

  // If agent filter is specified, use byAgent directly
  if (agent && scanResult.byAgent[agent]) {
    sessions = [...scanResult.byAgent[agent]!];
  } else {
    sessions = [...scanResult.sessions];
  }

  if (cwd) {
    sessions = sessions.filter((s) => s.directory.toLowerCase().includes(cwd));
  }

  if (from) {
    const fromTs = new Date(from).getTime();
    if (!Number.isNaN(fromTs)) {
      sessions = sessions.filter((s) => s.time_created >= fromTs);
    }
  }

  if (to) {
    const toTs = new Date(to).getTime();
    if (!Number.isNaN(toTs)) {
      sessions = sessions.filter((s) => s.time_created <= toTs);
    }
  }

  if (q) {
    sessions = sessions.filter((s) => s.title.toLowerCase().includes(q));
  }

  return c.json({ sessions });
}

export async function handleGetSessionData(c: Context, scanSource: ScanResultSource) {
  const scanResult = scanSource.getSnapshot();
  const agentName = c.req.param("agent");
  const sessionId = c.req.param("id");

  if (!sessionId) {
    return c.json({ error: "Missing session ID" }, 400);
  }

  const agent = scanResult.agents.find((a) => a.name === agentName);

  if (!agent) {
    return c.json({ error: `Unknown agent: ${agentName}` }, 404);
  }

  try {
    const data: SessionData = agent.getSessionData(sessionId);
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load session";
    return c.json({ error: message }, 500);
  }
}
