import type { Context } from "hono";
import type { BookmarkRecord, ScanResult, SessionData, SessionHead } from "@codesesh/core";
import {
  BookmarkStorageUnavailableError,
  deleteBookmark,
  getAgentInfoMap,
  importBookmarks,
  listBookmarks,
  searchSessions,
  syncSessionSearchIndex,
  upsertBookmark,
} from "@codesesh/core";

export interface ScanResultSource {
  getSnapshot(): ScanResult;
}

export interface SessionListDefaults {
  from?: number;
  to?: number;
  /** When --days was used, original value — kept for UI "last N days" label */
  days?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionStats(value: unknown): value is SessionHead["stats"] {
  if (!isRecord(value)) return false;
  return (
    typeof value.message_count === "number" &&
    typeof value.total_input_tokens === "number" &&
    typeof value.total_output_tokens === "number" &&
    typeof value.total_cost === "number" &&
    (value.total_tokens == null || typeof value.total_tokens === "number")
  );
}

function parseBookmarkPayload(value: unknown): Omit<BookmarkRecord, "bookmarked_at"> | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.agentKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.fullPath !== "string" ||
    typeof value.title !== "string" ||
    typeof value.directory !== "string" ||
    typeof value.time_created !== "number" ||
    (value.time_updated != null && typeof value.time_updated !== "number") ||
    !isSessionStats(value.stats)
  ) {
    return null;
  }

  return {
    agentKey: value.agentKey,
    sessionId: value.sessionId,
    fullPath: value.fullPath,
    title: value.title,
    directory: value.directory,
    time_created: value.time_created,
    time_updated: value.time_updated,
    stats: value.stats,
  };
}

function getTotalTokens(stats: SessionHead["stats"]): number {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

function getSessionActivityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(
  value: string | undefined,
  fallback: number | undefined,
  bound: "start" | "end" = "start",
): number | undefined {
  if (value == null) return fallback;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return fallback;
  // YYYY-MM-DD without time-of-day means "the whole day". For an upper
  // bound we need to extend to 23:59:59.999 of that day, otherwise
  // ?to=2026-04-26 truncates to that day's 00:00 UTC and excludes every
  // session active later that day. (When the value already carries a
  // time-of-day, respect it as-is.)
  if (bound === "end" && typeof value === "string" && DATE_ONLY_RE.test(value)) {
    return ts + 86400000 - 1;
  }
  return ts;
}

function parseDaysParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  if (value === "") return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  // days=0 explicitly opts into "all time"
  return n;
}

/**
 * Resolve a session-list time window from optional query params + CLI defaults.
 * Priority: explicit query > CLI defaults > undefined (no window).
 * `days` is converted to a `from` timestamp (now - days * 86400000) when no
 * explicit `from` is provided; `days=0` means "all time" and clears the window.
 */
function resolveListWindow(
  defaults: SessionListDefaults,
  queryDays: string | undefined,
  queryFrom: string | undefined,
  queryTo: string | undefined,
): { from: number | undefined; to: number | undefined } {
  const explicitDays = parseDaysParam(queryDays);
  const explicitFrom = parseDateParam(queryFrom, undefined);
  const explicitTo = parseDateParam(queryTo, undefined, "end");

  let from: number | undefined;
  let to: number | undefined = explicitTo ?? defaults.to;

  if (explicitFrom != null) {
    from = explicitFrom;
  } else if (explicitDays != null) {
    from = explicitDays > 0 ? Date.now() - explicitDays * 86400000 : undefined;
    if (explicitDays === 0) {
      // "all time" — also clear any default `to` so the window is fully open
      to = explicitTo;
    }
  } else {
    from = defaults.from;
  }

  return { from, to };
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
  const { from, to } = resolveListWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
  );
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
  const { from, to } = resolveListWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
  );

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
  const { from, to } = resolveListWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
  );

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

export function handleGetBookmarks(c: Context) {
  try {
    return c.json({ bookmarks: listBookmarks(), storageAvailable: true });
  } catch (error) {
    if (error instanceof BookmarkStorageUnavailableError) {
      return c.json({ bookmarks: [], storageAvailable: false });
    }
    throw error;
  }
}

export async function handlePutBookmark(c: Context) {
  const payload = parseBookmarkPayload(await c.req.json().catch(() => null));
  if (!payload) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  try {
    return c.json({ bookmark: upsertBookmark(payload), storageAvailable: true });
  } catch (error) {
    if (error instanceof BookmarkStorageUnavailableError) {
      return c.json({ error: "Bookmark storage is unavailable" }, 503);
    }
    throw error;
  }
}

export async function handleImportBookmarks(c: Context) {
  const payload = await c.req.json().catch(() => null);
  if (!Array.isArray(payload)) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  const bookmarks = payload
    .map((entry) => parseBookmarkPayload(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (bookmarks.length !== payload.length) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  try {
    return c.json({ bookmarks: importBookmarks(bookmarks), storageAvailable: true });
  } catch (error) {
    if (error instanceof BookmarkStorageUnavailableError) {
      return c.json({ error: "Bookmark storage is unavailable" }, 503);
    }
    throw error;
  }
}

export function handleDeleteBookmark(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  if (!agentKey || !sessionId) {
    return c.json({ error: "Missing bookmark identifier" }, 400);
  }

  try {
    deleteBookmark(agentKey, sessionId);
    return c.json({ ok: true, storageAvailable: true });
  } catch (error) {
    if (error instanceof BookmarkStorageUnavailableError) {
      return c.json({ error: "Bookmark storage is unavailable" }, 503);
    }
    throw error;
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

export interface DailyTokenBucket {
  date: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface ModelDistributionEntry {
  model: string;
  tokens: number;
  sessions: number;
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
  dailyTokenActivity: DailyTokenBucket[];
  modelDistribution: ModelDistributionEntry[];
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
  earliestSessionTs?: number,
): { from: number; to: number; days: number } {
  const now = Date.now();
  const todayStart = startOfLocalDay(now);

  // Query "to" wins over defaults, then "now" end-of-today as fallback
  const toTs = parseDateParam(queryTo, defaults.to, "end") ?? todayStart + 24 * 60 * 60 * 1000 - 1;

  const hasQueryFrom = queryFrom != null && queryFrom !== "";
  const fromFromQuery = parseDateParam(queryFrom, undefined);

  // Resolve days (preferred): query, defaults.days, or derive from defaults.from
  const parsedDays = queryDays ? parseInt(queryDays, 10) : NaN;
  if (parsedDays === 0 && !hasQueryFrom) {
    const fromTs = startOfLocalDay(earliestSessionTs ?? todayStart);
    const days = Math.max(1, Math.ceil((todayStart - fromTs) / 86400000) + 1);
    return { from: fromTs, to: toTs, days };
  }

  let days: number | undefined =
    Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : defaults.days;

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
  const earliestActivity =
    scanResult.sessions.length > 0
      ? Math.min(
          ...scanResult.sessions.map((session) => session.time_updated ?? session.time_created),
        )
      : Date.now();
  const { from, to, days } = resolveDashboardWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
    earliestActivity,
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
  const dailyTokenMap = new Map<string, DailyTokenBucket>();
  const bucketStart = startOfLocalDay(from);
  for (let i = 0; i < days; i += 1) {
    const ts = bucketStart + i * 86400000;
    const key = toLocalDateKey(ts);
    dailyMap.set(key, { date: key, sessions: 0, messages: 0 });
    dailyTokenMap.set(key, { date: key, input: 0, output: 0, cache_read: 0, cache_create: 0 });
  }

  const modelAgg = new Map<string, { tokens: number; sessions: number }>();

  for (const session of windowed) {
    const key = toLocalDateKey(getSessionActivityTime(session));
    const bucket = dailyMap.get(key);
    if (bucket) {
      bucket.sessions += 1;
      bucket.messages += session.stats.message_count;
    }

    const tokenBucket = dailyTokenMap.get(key);
    if (tokenBucket) {
      const cacheRead = session.stats.total_cache_read_tokens ?? 0;
      const cacheCreate = session.stats.total_cache_create_tokens ?? 0;
      const pureInput = session.stats.total_input_tokens - cacheRead - cacheCreate;
      tokenBucket.input += Math.max(0, pureInput);
      tokenBucket.output += session.stats.total_output_tokens;
      tokenBucket.cache_read += cacheRead;
      tokenBucket.cache_create += cacheCreate;
    }

    if (session.model_usage) {
      for (const [model, tokens] of Object.entries(session.model_usage)) {
        const entry = modelAgg.get(model);
        if (entry) {
          entry.tokens += tokens;
          entry.sessions += 1;
        } else {
          modelAgg.set(model, { tokens, sessions: 1 });
        }
      }
    }
  }

  const dailyActivity = [...dailyMap.values()];
  const dailyTokenActivity = [...dailyTokenMap.values()];

  const modelDistribution: ModelDistributionEntry[] = [...modelAgg.entries()]
    .map(([model, { tokens, sessions: count }]) => ({ model, tokens, sessions: count }))
    .sort((a, b) => b.tokens - a.tokens);

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
    dailyTokenActivity,
    modelDistribution,
    recentSessions,
    window: { from, to, days },
  };

  return c.json(data);
}
