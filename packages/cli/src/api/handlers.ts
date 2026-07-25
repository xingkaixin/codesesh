import type { Context } from "hono";
import type {
  BookmarkRecord,
  ScanResult,
  SessionCacheMeta,
  SessionData,
  SessionHead,
  SmartTag,
} from "@codesesh/core";
import type { AppConfig, ScanStatusEvent } from "@codesesh/core/contract";
import {
  BookmarkStorageUnavailableError,
  StateStorageUnavailableError,
  attachProjectMetrics,
  createProjectScopeMatcher,
  deleteBookmark,
  getAgentInfoMap,
  classifySessionTags,
  computeIdentity,
  executeSessionSearch,
  extractSessionFileActivity,
  getSmartTagSourceTimestamp,
  importBookmarks,
  loadCachedSessionDataEntry,
  listFileActivity,
  listSessionFileActivity,
  listCachedProjectGroups,
  listBookmarks,
  deleteSessionAlias,
  upsertSessionAlias,
  realFs,
  upsertBookmark,
  matchesProjectScope as sessionMatchesProjectScope,
  matchesProjectIdentity,
  buildDashboard,
  type DashboardData,
  type DashboardScope,
} from "@codesesh/core";
import { appLogger } from "../logging.js";
import { resolveTimeWindow } from "../time-window-resolution.js";
import {
  filterSessionsByActivityWindow,
  parseDateParam,
  parseFileActivityKind,
  parseProjectIdentityFilter,
  parseSearchOptions,
  optionalQueryValue,
  type SessionListDefaults,
} from "./query-params.js";
import {
  decorateBookmark,
  decorateFileActivity,
  findAliasSearchResults,
  getSessionAgentKey,
  invalidateAliasView,
  loadAliasView,
} from "./session-aliases-view.js";

export type { SessionListDefaults };

export interface ScanResultSource {
  getSnapshot(): ScanResult;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}

interface ClientLogPayload {
  event?: unknown;
  data?: unknown;
}

function cacheMatchesCurrentSource(
  cachedMeta: SessionCacheMeta | null,
  currentMeta: SessionCacheMeta | undefined,
) {
  const currentFingerprint = currentMeta?.sourceFingerprint;
  if (typeof currentFingerprint !== "string") return true;
  return cachedMeta?.sourceFingerprint === currentFingerprint;
}

interface SessionAliasPayload {
  alias?: unknown;
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
    time_updated: value.time_updated ?? undefined,
    stats: value.stats,
  };
}

function sanitizeClientLogData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]) => {
        if (typeof item === "string") return [key, item.slice(0, 300)];
        if (typeof item === "number" || typeof item === "boolean" || item == null) {
          return [key, item];
        }
        return [key, String(item).slice(0, 300)];
      }),
  );
}

export function handleGetConfig(c: Context, defaults: SessionListDefaults) {
  const payload: AppConfig = {
    window: {
      from: defaults.from,
      to: defaults.to,
      days: defaults.days,
    },
  };
  return c.json(payload);
}

export function handleGetScanStatus(c: Context, scanSource: ScanStatusSource) {
  return c.json(scanSource.getScanStatus());
}

export function handleGetAgents(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);
  const counts = Object.fromEntries(
    Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [
      agentName,
      filterSessionsByActivityWindow(sessions, from, to).length,
    ]),
  );
  return c.json(getAgentInfoMap(counts));
}

export function handleGetProjects(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);
  const sessions = filterSessionsByActivityWindow(scanResult.sessions, from, to);
  return c.json({
    projects: attachProjectMetrics(listCachedProjectGroups(sessions), sessions),
  });
}

export function handleGetSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const agent = c.req.query("agent");
  const q = c.req.query("q")?.toLowerCase();
  const cwd = c.req.query("cwd");
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const tag = c.req.query("tag")?.toLowerCase();
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);

  let sessions: SessionHead[] = [];

  // If agent filter is specified, use byAgent directly
  if (agent && scanResult.byAgent[agent]) {
    sessions = [...scanResult.byAgent[agent]!];
  } else {
    sessions = [...scanResult.sessions];
  }

  if (projectIdentity) {
    sessions = sessions.filter((session) =>
      matchesProjectIdentity(session.project_identity, projectIdentity),
    );
  } else if (cwd) {
    const projectScope = createProjectScopeMatcher(cwd);
    sessions = sessions.filter((s) => sessionMatchesProjectScope(s, projectScope));
  }
  sessions = filterSessionsByActivityWindow(sessions, from, to);
  if (tag) {
    sessions = sessions.filter((s) => s.smart_tags?.includes(tag as SmartTag));
  }

  const aliases = loadAliasView();
  if (q) {
    sessions = sessions.filter((session) => {
      const alias = aliases.get(getSessionAgentKey(session), session.id);
      return session.title.toLowerCase().includes(q) || alias?.toLowerCase().includes(q);
    });
  }
  return c.json({
    sessions: sessions.map((session) => aliases.decorate(session, getSessionAgentKey(session))),
  });
}

export function handleSearchSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const query = c.req.query("q")?.trim() ?? "";
  const scanResult = scanSource.getSnapshot();
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const searchOptions = parseSearchOptions(c, defaults, projectIdentity);
  const aliases = loadAliasView();
  const results = executeSessionSearch(query, searchOptions, scanResult).map((result) => ({
    ...result,
    session: aliases.decorate(result.session, result.agentName),
  }));
  const aliasResults = findAliasSearchResults(query, searchOptions, scanResult, aliases);
  const deduped = new Map<string, (typeof results)[number]>();
  for (const result of [...aliasResults, ...results]) {
    deduped.set(`${result.agentName}\0${result.session.id}`, result);
  }
  return c.json({ results: [...deduped.values()].slice(0, searchOptions.limit ?? 50) });
}

export function handleGetFileActivity(c: Context, defaults: SessionListDefaults = {}) {
  const limitValue = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 200) : 50;
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }

  const aliases = loadAliasView();
  return c.json({
    activity: listFileActivity({
      agent: optionalQueryValue(c.req.query("agent")),
      sessionId: optionalQueryValue(c.req.query("sessionId")),
      projectKind: projectIdentity?.kind,
      projectKey: projectIdentity?.key,
      project: optionalQueryValue(c.req.query("project")),
      cwd: optionalQueryValue(c.req.query("cwd")),
      path: optionalQueryValue(c.req.query("path")),
      kind: parseFileActivityKind(optionalQueryValue(c.req.query("kind"))),
      from: parseDateParam(c.req.query("from"), defaults.from),
      to: parseDateParam(c.req.query("to"), defaults.to),
      limit,
    }).map((activity) => decorateFileActivity(activity, aliases)),
  });
}

export async function handleGetSessionData(c: Context, scanSource: ScanResultSource) {
  const startedAt = performance.now();
  const scanResult = scanSource.getSnapshot();
  const agentName = c.req.param("agent");
  const sessionId = c.req.param("id");

  if (!agentName) {
    return c.json({ error: "Missing agent name" }, 400);
  }

  if (!sessionId) {
    return c.json({ error: "Missing session ID" }, 400);
  }

  const agent = scanResult.agents.find((a) => a.name === agentName);

  if (!agent) {
    return c.json({ error: `Unknown agent: ${agentName}` }, 404);
  }

  try {
    const head = scanResult.byAgent[agentName]?.find((item) => item.id === sessionId);
    const loadStartedAt = performance.now();
    const cachedEntry = loadCachedSessionDataEntry(agentName, sessionId);
    const cachedData = cachedEntry?.data ?? null;
    const cachedMessageCount = cachedData?.stats.message_count ?? 0;
    const currentMeta = head ? agent.getSessionMetaMap().get(sessionId) : undefined;
    const cacheHasExpectedMessages =
      cachedData !== null &&
      cacheMatchesCurrentSource(cachedEntry?.meta ?? null, currentMeta) &&
      (cachedData.messages.length > 0 || cachedMessageCount === 0);
    const data: SessionData | null = cacheHasExpectedMessages
      ? cachedData
      : head
        ? agent.getSessionData(sessionId)
        : null;
    const loadDuration = performance.now() - loadStartedAt;
    if (!data) {
      appLogger.warn("api.session_data.cache_miss", {
        agent: agentName,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return c.json({ error: "Session cache not ready" }, 404);
    }
    const tagStartedAt = performance.now();
    const smartTags = data.smart_tags ?? classifySessionTags(data);
    const tagDuration = performance.now() - tagStartedAt;
    const projectIdentity =
      data.project_identity ?? head?.project_identity ?? computeIdentity(data.directory, realFs);
    const fileActivity =
      data.file_activity ??
      (cacheHasExpectedMessages && cachedData
        ? listSessionFileActivity(agentName, sessionId)
        : extractSessionFileActivity(agentName, sessionId, projectIdentity.key, data.messages));
    appLogger.info("api.session_data", {
      agent: agentName,
      session_id: sessionId,
      messages: data.messages.length,
      load_duration_ms: Math.round(loadDuration),
      tag_duration_ms: Math.round(tagDuration),
      duration_ms: Math.round(performance.now() - startedAt),
    });
    const aliases = loadAliasView();
    return c.json({
      ...aliases.decorate(data, agentName),
      project_identity: projectIdentity,
      smart_tags: smartTags,
      smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      file_activity: fileActivity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load session";
    appLogger.error("api.session_data.error", {
      agent: agentName,
      session_id: sessionId,
      duration_ms: Math.round(performance.now() - startedAt),
      error: message,
    });
    return c.json({ error: message }, 500);
  }
}

export async function handlePostClientLog(c: Context) {
  const payload = (await c.req.json().catch(() => null)) as ClientLogPayload | null;
  const rawEvent = payload?.event;

  if (typeof rawEvent !== "string" || !rawEvent.trim()) {
    return c.json({ ok: false }, 400);
  }

  const event = rawEvent
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120);
  appLogger.info(`client.${event}`, sanitizeClientLogData(payload?.data));
  return c.json({ ok: true });
}

export function handleGetBookmarks(c: Context) {
  try {
    const aliases = loadAliasView();
    return c.json({
      bookmarks: listBookmarks().map((bookmark) => decorateBookmark(bookmark, aliases)),
      storageAvailable: true,
    });
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

export async function handlePutSessionAlias(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  const payload = (await c.req.json().catch(() => null)) as SessionAliasPayload | null;
  if (!agentKey || !sessionId || typeof payload?.alias !== "string") {
    return c.json({ error: "Invalid session alias payload" }, 400);
  }

  try {
    const alias = upsertSessionAlias(agentKey, sessionId, payload.alias);
    invalidateAliasView();
    return c.json({ alias });
  } catch (error) {
    if (error instanceof TypeError) {
      return c.json({ error: "Session alias must be non-empty and at most 160 characters" }, 400);
    }
    if (error instanceof StateStorageUnavailableError) {
      return c.json({ error: "Session alias storage is unavailable" }, 503);
    }
    throw error;
  }
}

export function handleDeleteSessionAlias(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  if (!agentKey || !sessionId) {
    return c.json({ error: "Missing session alias identifier" }, 400);
  }

  try {
    deleteSessionAlias(agentKey, sessionId);
    invalidateAliasView();
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof StateStorageUnavailableError) {
      return c.json({ error: "Session alias storage is unavailable" }, 503);
    }
    throw error;
  }
}

export function handleGetDashboard(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const { from, to, days } = resolveTimeWindow({
    mode: "dashboard",
    query: {
      days: c.req.query("days"),
      from: c.req.query("from"),
      to: c.req.query("to"),
    },
    defaults,
  });
  const scope: DashboardScope = {
    agent: optionalQueryValue(c.req.query("agent"))?.toLowerCase(),
    projectKind: projectIdentity?.kind,
    projectKey: projectIdentity?.key,
  };

  const agentInfo = getAgentInfoMap({});
  const agentInfoMap = new Map(agentInfo.map((a) => [a.name, a]));

  const aggregate = buildDashboard(scanResult.sessions, {
    byAgentNames: Object.keys(scanResult.byAgent),
    scope,
    from,
    to,
    agentInfoMap,
  });

  const data: DashboardData = {
    ...aggregate,
    recentFileActivities: listFileActivity({
      agent: scope.agent,
      projectKind: scope.projectKind,
      projectKey: scope.projectKey,
      from,
      to,
      limit: 12,
    }),
    window: { from, to, days },
  };

  const aliases = loadAliasView();
  return c.json({
    ...data,
    recentSessions: data.recentSessions.map((session) =>
      aliases.decorate(session, session.agentName),
    ),
    recentFileActivities: data.recentFileActivities.map((activity) =>
      decorateFileActivity(activity, aliases),
    ),
  });
}
