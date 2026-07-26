import type { Context } from "hono";
import type {
  BookmarkRecord,
  LiveSnapshot,
  SessionDetail,
  SessionHead,
  SmartTag,
} from "@codesesh/core";
import {
  formatSessionReference,
  getSessionAgentKey,
  normalizeSessionReference,
  type AppConfig,
  type ScanStatusEvent,
  type SessionReference,
} from "@codesesh/core/contract";
import {
  SessionAliasValidationError,
  StateStorageUnavailableError,
  attachProjectMetrics,
  createProjectScopeMatcher,
  deleteBookmark,
  getAgentInfoMap,
  executeSessionSearch,
  importBookmarks,
  listFileActivity,
  listCachedProjectGroups,
  listBookmarks,
  deleteSessionAlias,
  materializeSessionDetailResponse,
  upsertSessionAlias,
  upsertBookmark,
  matchesProjectScope as sessionMatchesProjectScope,
  matchesProjectIdentity,
  buildDashboard,
  startOfLocalDay,
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
  invalidateAliasView,
  loadAliasView,
} from "./session-aliases-view.js";

export type { SessionListDefaults };

export interface ScanResultSource {
  getSnapshot(): LiveSnapshot;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}

interface SnapshotAggregationCache {
  sessions: SessionHead[];
  values: Map<string, unknown>;
}

const SNAPSHOT_AGGREGATION_CACHE_LIMIT = 64;
const snapshotAggregationCaches = new WeakMap<ScanResultSource, SnapshotAggregationCache>();

/**
 * LiveScanStore replaces its canonical sessions array whenever the snapshot
 * changes, so that existing reference is the snapshot version.
 */
function getSnapshotAggregation<T>(
  source: ScanResultSource,
  sessions: SessionHead[],
  key: readonly unknown[],
  build: () => T,
): T {
  let cache = snapshotAggregationCaches.get(source);
  if (!cache || cache.sessions !== sessions) {
    cache = { sessions, values: new Map() };
    snapshotAggregationCaches.set(source, cache);
  }

  const cacheKey = JSON.stringify(key);
  if (cache.values.has(cacheKey)) return cache.values.get(cacheKey) as T;

  const value = build();
  if (cache.values.size >= SNAPSHOT_AGGREGATION_CACHE_LIMIT) {
    const oldestKey = cache.values.keys().next().value;
    if (oldestKey != null) cache.values.delete(oldestKey);
  }
  cache.values.set(cacheKey, value);
  return value;
}

interface ClientLogPayload {
  event?: unknown;
  data?: unknown;
}

interface SessionAliasPayload {
  alias?: unknown;
}

function withStorageErrors<TResult, TFallback>(
  handler: () => TResult,
  onUnavailable: () => TFallback,
): TResult | TFallback {
  try {
    return handler();
  } catch (error) {
    if (error instanceof StateStorageUnavailableError) {
      return onUnavailable();
    }
    throw error;
  }
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

type BookmarkInput = Omit<BookmarkRecord, "bookmarkedAt">;

function parseBookmarkSession(
  value: unknown,
  reference: SessionReference,
): BookmarkInput["session"] | null {
  if (!isRecord(value)) return null;
  if (
    value.id !== reference.sessionId ||
    typeof value.slug !== "string" ||
    typeof value.title !== "string" ||
    typeof value.directory !== "string" ||
    typeof value.time_created !== "number" ||
    (value.time_updated != null && typeof value.time_updated !== "number") ||
    !isSessionStats(value.stats)
  ) {
    return null;
  }

  return {
    id: reference.sessionId,
    slug: formatSessionReference(reference),
    title: value.title,
    directory: value.directory,
    time_created: value.time_created,
    time_updated: value.time_updated ?? undefined,
    stats: value.stats,
  };
}

function parseSessionReferencePayload(value: unknown): SessionReference | null {
  if (
    !isRecord(value) ||
    typeof value.agentName !== "string" ||
    typeof value.sessionId !== "string" ||
    !value.agentName.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  return normalizeSessionReference({
    agentName: value.agentName.trim().toLowerCase(),
    sessionId: value.sessionId,
  });
}

function parseBookmarkPayload(value: unknown): BookmarkInput | null {
  if (!isRecord(value)) return null;

  const reference = parseSessionReferencePayload(value.reference);
  if (reference) {
    const session = parseBookmarkSession(value.session, reference);
    return session ? { reference, session } : null;
  }

  if (
    typeof value.agentKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.fullPath !== "string" ||
    !value.agentKey.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  const legacyReference = normalizeSessionReference({
    agentName: value.agentKey.trim().toLowerCase(),
    sessionId: value.sessionId,
  });
  const session = parseBookmarkSession(
    {
      ...value,
      id: value.sessionId,
      slug: value.fullPath,
    },
    legacyReference,
  );
  return session ? { reference: legacyReference, session } : null;
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

function toSessionListItem(session: SessionHead): SessionHead {
  if (!session.model_usage) return session;
  const item = { ...session };
  delete item.model_usage;
  return item;
}

function getSessionHeadReference(session: SessionHead): SessionReference {
  return {
    agentName: getSessionAgentKey(session),
    sessionId: session.id,
  };
}

function createSessionDetailJsonResponse(
  data: Omit<SessionDetail, "messages">,
  messages: Iterable<string>,
): Response {
  const encoder = new TextEncoder();
  const headerJson = JSON.stringify(data);
  const iterator = messages[Symbol.iterator]();
  let wroteHeader = false;
  let wroteMessage = false;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(`${headerJson.slice(0, -1)},"messages":[`));
          wroteHeader = true;
          return;
        }

        const next = iterator.next();
        if (!next.done) {
          controller.enqueue(encoder.encode(`${wroteMessage ? "," : ""}${next.value}`));
          wroteMessage = true;
          return;
        }

        controller.enqueue(encoder.encode("]}"));
        controller.close();
      },
      cancel() {
        iterator.return?.();
      },
    }),
    { headers: { "Content-Type": "application/json; charset=UTF-8" } },
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
  const agents = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    ["agents", from, to],
    () => {
      const counts = Object.fromEntries(
        Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [
          agentName,
          filterSessionsByActivityWindow(sessions, from, to).length,
        ]),
      );
      return getAgentInfoMap(counts);
    },
  );
  return c.json(agents);
}

export function handleGetProjects(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const from = parseDateParam(c.req.query("from"), defaults.from);
  const to = parseDateParam(c.req.query("to"), defaults.to);
  const projects = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    ["projects", from, to],
    () => {
      const sessions = filterSessionsByActivityWindow(scanResult.sessions, from, to);
      return {
        projects: attachProjectMetrics(listCachedProjectGroups(sessions), sessions),
      };
    },
  );
  return c.json(projects);
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
      const alias = aliases.get(getSessionHeadReference(session));
      return session.title.toLowerCase().includes(q) || alias?.toLowerCase().includes(q);
    });
  }
  return c.json({
    sessions: sessions.map((session) =>
      toSessionListItem(aliases.decorate(session, getSessionHeadReference(session))),
    ),
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
    session: aliases.decorate(result.session, result.reference),
  }));
  const aliasResults = findAliasSearchResults(query, searchOptions, scanResult, aliases);
  const deduped = new Map<string, (typeof results)[number]>();
  for (const result of [...aliasResults, ...results]) {
    deduped.set(`${result.reference.agentName}\0${result.reference.sessionId}`, result);
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
  const agentName = c.req.param("agent");
  const sessionId = c.req.param("id");

  if (!agentName) {
    return c.json({ error: "Missing agent name" }, 400);
  }

  if (!sessionId) {
    return c.json({ error: "Missing session ID" }, 400);
  }

  try {
    const result = materializeSessionDetailResponse(scanSource.getSnapshot(), {
      agentName,
      sessionId,
    });
    if (result.status === "unknown-agent") {
      return c.json({ error: `Unknown agent: ${agentName}` }, 404);
    }
    if (result.status === "not-ready") {
      appLogger.warn("api.session_data.cache_miss", {
        agent: agentName,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return c.json({ error: "Session cache not ready" }, 404);
    }

    appLogger.info("api.session_data", {
      agent: agentName,
      session_id: sessionId,
      messages: result.status === "found-json" ? result.messageCount : result.data.messages.length,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    const aliases = loadAliasView();
    if (result.status === "found-json") {
      return createSessionDetailJsonResponse(
        aliases.decorate(result.data, result.data.reference),
        result.messages,
      );
    }
    return c.json(aliases.decorate(result.data, result.data.reference));
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
  return withStorageErrors(
    () => {
      const aliases = loadAliasView();
      return c.json({
        bookmarks: listBookmarks().map((bookmark) => decorateBookmark(bookmark, aliases)),
        storageAvailable: true,
      });
    },
    () => c.json({ bookmarks: [], storageAvailable: false }),
  );
}

export async function handlePutBookmark(c: Context) {
  const payload = parseBookmarkPayload(await c.req.json().catch(() => null));
  if (!payload) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  return withStorageErrors(
    () => c.json({ bookmark: upsertBookmark(payload), storageAvailable: true }),
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
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

  return withStorageErrors(
    () => c.json({ bookmarks: importBookmarks(bookmarks), storageAvailable: true }),
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export function handleDeleteBookmark(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  if (!agentKey || !sessionId) {
    return c.json({ error: "Missing bookmark identifier" }, 400);
  }

  return withStorageErrors(
    () => {
      deleteBookmark({ agentName: agentKey, sessionId });
      return c.json({ ok: true, storageAvailable: true });
    },
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export async function handlePutSessionAlias(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  const payload = (await c.req.json().catch(() => null)) as SessionAliasPayload | null;
  const aliasValue = payload?.alias;
  if (!agentKey || !sessionId || typeof aliasValue !== "string") {
    return c.json({ error: "Invalid session alias payload" }, 400);
  }

  try {
    return withStorageErrors(
      () => {
        const alias = upsertSessionAlias({ agentName: agentKey, sessionId }, aliasValue);
        invalidateAliasView();
        return c.json({ alias });
      },
      () => c.json({ error: "Session alias storage is unavailable" }, 503),
    );
  } catch (error) {
    if (error instanceof SessionAliasValidationError) {
      return c.json({ error: "Session alias must be non-empty and at most 160 characters" }, 400);
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

  return withStorageErrors(
    () => {
      deleteSessionAlias({ agentName: agentKey, sessionId });
      invalidateAliasView();
      return c.json({ ok: true });
    },
    () => c.json({ error: "Session alias storage is unavailable" }, 503),
  );
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

  const fixedTo = parseDateParam(c.req.query("to"), defaults.to);
  const aggregate = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "dashboard",
      scope.agent,
      scope.projectKind,
      scope.projectKey,
      from,
      fixedTo ?? startOfLocalDay(to),
    ],
    () => {
      const agentInfo = getAgentInfoMap({});
      const agentInfoMap = new Map(agentInfo.map((agent) => [agent.name, agent]));
      return buildDashboard(scanResult.sessions, {
        byAgentNames: Object.keys(scanResult.byAgent),
        scope,
        from,
        to,
        agentInfoMap,
      });
    },
  );

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
    recentSessions: data.recentSessions.map((item) => ({
      ...item,
      session: aliases.decorate(item.session, item.reference),
    })),
    recentFileActivities: data.recentFileActivities.map((activity) =>
      decorateFileActivity(activity, aliases),
    ),
  });
}
