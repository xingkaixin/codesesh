import type { Context } from "hono";
import type { ScanResult, SessionData, SessionHead } from "@codesesh/core";
import { getAgentInfoMap, searchSessions, syncSessionSearchIndex } from "@codesesh/core";

export interface ScanResultSource {
  getSnapshot(): ScanResult;
}

export interface SessionListDefaults {
  from?: number;
  to?: number;
  /** When --days was used, original value — kept for UI "last N days" label */
  days?: number;
}

function getTotalTokens(stats: SessionHead["stats"]): number {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

function getSessionActivityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

function parseDateParam(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value == null) return fallback;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? fallback : ts;
}

function filterSessionsByWindow(
  sessions: SessionHead[],
  from: number | undefined,
  to: number | undefined,
): SessionHead[] {
  return filterSessionsByActivityWindow(sessions, from, to);
}

function filterSessionsByActivityWindow(
  sessions: SessionHead[],
  from: number | undefined,
  to: number | undefined,
): SessionHead[] {
  if (from == null && to == null) return sessions;
  return sessions.filter((session) => {
    const activity = getSessionActivityTime(session);
    if (from != null && activity < from) return false;
    if (to != null && activity > to) return false;
    return true;
  });
}

export function handleGetConfig(c: Context, defaults: SessionListDefaults) {
  return c.json({
    window: {
      from: defaults.from,
      to: defaults.to,
      days: defaults.days,
    },
  });
}

export function handleGetAgents(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const { from, to } = defaults;
  const counts = Object.fromEntries(
    Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [
      agentName,
      filterSessionsByWindow(sessions, from, to).length,
    ]),
  );
  const info = getAgentInfoMap(counts);
  return c.json(info);
}

export function handleGetSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const agent = c.req.query("agent");
  const q = c.req.query("q")?.toLowerCase();
  const cwd = c.req.query("cwd")?.toLowerCase();
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);

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
  sessions = filterSessionsByActivityWindow(sessions, from, to);

  if (q) {
    sessions = sessions.filter((s) => s.title.toLowerCase().includes(q));
  }

  return c.json({ sessions });
}

export function handleSearchSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const query = c.req.query("q")?.trim() ?? "";
  if (!query) {
    return c.json({ results: [] });
  }

  const scanResult = scanSource.getSnapshot();
  const agent = c.req.query("agent");
  const cwd = c.req.query("cwd");
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);

  for (const indexedAgent of scanResult.agents) {
    const sessions = scanResult.byAgent[indexedAgent.name] ?? [];
    syncSessionSearchIndex(indexedAgent.name, sessions, (sessionId) =>
      indexedAgent.getSessionData(sessionId),
    );
  }

  const results = searchSessions(query, {
    agent,
    cwd,
    from,
    to,
    limit: 50,
  });

  return c.json({ results });
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

export interface DashboardAgentStat {
  name: string;
  displayName: string;
  icon: string;
  sessions: number;
  messages: number;
  tokens: number;
}

export interface DashboardDailyBucket {
  /** Local YYYY-MM-DD */
  date: string;
  sessions: number;
  messages: number;
}

export interface DashboardTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  latestActivity?: number;
}

export interface DashboardRecentSession extends SessionHead {
  agentName: string;
}

export interface DashboardData {
  totals: DashboardTotals;
  perAgent: DashboardAgentStat[];
  dailyActivity: DashboardDailyBucket[];
  recentSessions: DashboardRecentSession[];
  /** Time window covered by dailyActivity (inclusive, ms) */
  window: { from: number; to: number; days: number };
}

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function resolveDashboardWindow(
  defaults: SessionListDefaults,
  queryDays: string | undefined,
  queryFrom: string | undefined,
  queryTo: string | undefined,
): { from: number; to: number; days: number } {
  const now = Date.now();
  const todayStart = startOfLocalDay(now);

  // Query "to" wins over defaults, then "now" end-of-today as fallback
  const toTs = parseDateParam(queryTo, defaults.to) ?? todayStart + 24 * 60 * 60 * 1000 - 1;

  // Resolve days (preferred): query, defaults.days, or derive from defaults.from
  const parsedDays = queryDays ? parseInt(queryDays, 10) : NaN;
  let days: number | undefined =
    Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : defaults.days;

  const fromFromQuery = parseDateParam(queryFrom, undefined);
  let fromTs: number;
  if (fromFromQuery != null) {
    fromTs = startOfLocalDay(fromFromQuery);
    days ??= Math.max(1, Math.ceil((todayStart - fromTs) / 86400000) + 1);
  } else if (days && days > 0) {
    fromTs = todayStart - (days - 1) * 86400000;
  } else if (defaults.from != null) {
    fromTs = startOfLocalDay(defaults.from);
    days = Math.max(1, Math.ceil((todayStart - fromTs) / 86400000) + 1);
  } else {
    days = 30;
    fromTs = todayStart - (days - 1) * 86400000;
  }

  return { from: fromTs, to: toTs, days };
}

export function handleGetDashboard(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const { from, to, days } = resolveDashboardWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
  );

  const windowed = filterSessionsByActivityWindow(scanResult.sessions, from, to);

  const agentInfo = getAgentInfoMap(
    Object.fromEntries(
      Object.entries(scanResult.byAgent).map(([name, sessions]) => [
        name,
        filterSessionsByActivityWindow(sessions, from, to).length,
      ]),
    ),
  );
  const agentInfoMap = new Map(agentInfo.map((a) => [a.name, a]));

  let totalMessages = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let latestActivity = 0;
  for (const session of windowed) {
    totalMessages += session.stats.message_count;
    totalTokens += getTotalTokens(session.stats);
    totalCost += session.stats.total_cost ?? 0;
    const activity = getSessionActivityTime(session);
    if (activity > latestActivity) latestActivity = activity;
  }

  const perAgent: DashboardAgentStat[] = Object.entries(scanResult.byAgent)
    .map(([name, sessions]) => {
      const info = agentInfoMap.get(name);
      const agentWindowed = filterSessionsByActivityWindow(sessions, from, to);
      let messages = 0;
      let tokens = 0;
      for (const s of agentWindowed) {
        messages += s.stats.message_count;
        tokens += getTotalTokens(s.stats);
      }
      return {
        name,
        displayName: info?.displayName ?? name,
        icon: info?.icon ?? "",
        sessions: agentWindowed.length,
        messages,
        tokens,
      };
    })
    .filter((item) => item.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);

  // Daily activity buckets — one bucket per local day in [from, to]
  const dailyMap = new Map<string, DashboardDailyBucket>();
  const bucketStart = startOfLocalDay(from);
  for (let i = 0; i < days; i += 1) {
    const ts = bucketStart + i * 86400000;
    const key = toLocalDateKey(ts);
    dailyMap.set(key, { date: key, sessions: 0, messages: 0 });
  }

  for (const session of windowed) {
    const key = toLocalDateKey(getSessionActivityTime(session));
    const bucket = dailyMap.get(key);
    if (bucket) {
      bucket.sessions += 1;
      bucket.messages += session.stats.message_count;
    }
  }

  const dailyActivity = [...dailyMap.values()];

  const recentSessions: DashboardRecentSession[] = [...windowed]
    .sort((a, b) => getSessionActivityTime(b) - getSessionActivityTime(a))
    .slice(0, 10)
    .map((session) => {
      const agentKey = session.slug.split("/")[0] ?? "unknown";
      return { ...session, agentName: agentKey };
    });

  const data: DashboardData = {
    totals: {
      sessions: windowed.length,
      messages: totalMessages,
      tokens: totalTokens,
      cost: totalCost,
      latestActivity: latestActivity || undefined,
    },
    perAgent,
    dailyActivity,
    recentSessions,
    window: { from, to, days },
  };

  return c.json(data);
}
