import type { Context } from "hono";
import type {
  BookmarkRecord,
  BookmarkView,
  LiveSnapshot,
  SessionDetail,
  SessionHead,
  SmartTag,
} from "@codesesh/core";
import {
  addCalendarDays,
  countCalendarDays,
  createSessionIndex,
  formatSessionReference,
  getSessionAgentKey,
  getSessionRouteKey,
  normalizeSessionReference,
  type AppConfig,
  type ScanStatusEvent,
  type SearchResult,
  type SessionReference,
  startOfCalendarDay,
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
  loadCachedSessionHeads,
  listBookmarks,
  listModelCostDistribution,
  deleteSessionAlias,
  materializeSessionDetailResponse,
  materializeBookmarkViews,
  upsertSessionAlias,
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
  FILE_ACTIVITY_LIMIT_POLICY,
  parseDateWindow,
  parseFileActivityKind,
  parseProjectIdentityFilter,
  parseSessionQuery,
  parseSearchOptions,
  optionalQueryValue,
  searchParams,
  SEARCH_LIMIT_POLICY,
  SESSION_PAGE_LIMIT_POLICY,
  type SessionListDefaults,
} from "./query-params.js";
import { paginateSessionSnapshot } from "./session-pagination.js";
import {
  decorateBookmark,
  decorateFileActivity,
  findAliasSearchResults,
  invalidateAliasView,
  loadAliasView,
  type AliasView,
} from "./session-aliases-view.js";

export type { SessionListDefaults };

export interface ScanResultSource {
  getSnapshot(): LiveSnapshot;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}

const KNOWN_AGENT_NAMES = getAgentInfoMap({}).map((agent) => agent.name);
const KNOWN_AGENT_NAME_SET = new Set(KNOWN_AGENT_NAMES);

function reportInvalidQueryParameter(
  endpoint: string,
  parameter: "agent" | "cursor" | "limit" | "from" | "to",
  validationOutcome: "empty_result" | "rejected",
): void {
  appLogger.warn("api.query_parameter.invalid", {
    endpoint,
    parameter,
    validation_outcome: validationOutcome,
  });
}

function parseDateWindowRequest(c: Context, endpoint: string, defaults: SessionListDefaults) {
  const outcome = parseDateWindow(searchParams(c), defaults);
  if (outcome.kind === "valid") return outcome;

  reportInvalidQueryParameter(endpoint, outcome.parameter, "rejected");
  return {
    kind: "rejected" as const,
    response: c.json({ error: `${outcome.parameter} ${outcome.error}` }, 400),
  };
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

function parseBookmarkReference(value: unknown): SessionReference | null {
  if (!isRecord(value)) return null;

  const reference = parseSessionReferencePayload(value.reference);
  if (reference) return reference;

  if (
    typeof value.agentKey !== "string" ||
    typeof value.sessionId !== "string" ||
    !value.agentKey.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  return normalizeSessionReference({
    agentName: value.agentKey.trim().toLowerCase(),
    sessionId: value.sessionId,
  });
}

function parseBookmarkImport(value: unknown): BookmarkRecord | null {
  if (!isRecord(value)) return null;
  const reference = parseBookmarkReference(value);
  if (!reference) return null;

  const timestamp = value.bookmarkedAt ?? value.bookmarked_at;
  if (timestamp != null && (typeof timestamp !== "number" || !Number.isFinite(timestamp))) {
    return null;
  }
  return {
    reference,
    bookmarkedAt: typeof timestamp === "number" ? timestamp : Date.now(),
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

function toSessionListItem(session: SessionHead): SessionHead {
  const {
    model_usage: _modelUsage,
    project_identity_resolver_revision: _resolverRevision,
    project_identity_input_signature: _identityInputSignature,
    smart_tags_source_updated_at: _smartTagsSourceUpdatedAt,
    smart_tags_classifier_revision: _smartTagsClassifierRevision,
    ...item
  } = session;
  return item;
}

function getSessionHeadReference(session: SessionHead): SessionReference {
  return {
    agentName: getSessionAgentKey(session),
    sessionId: session.id,
  };
}

const SESSION_DETAIL_STREAM_BATCH_CHARS = 64 * 1024;

function createSessionDetailJsonResponse(
  data: Omit<SessionDetail, "messages">,
  messages: Iterable<string>,
): Response {
  const encoder = new TextEncoder();
  const headerJson = JSON.stringify(data);
  const headerPrefix =
    headerJson === "{}" ? '{"messages":[' : `${headerJson.slice(0, -1)},"messages":[`;
  const iterator = messages[Symbol.iterator]();
  let wroteHeader = false;
  let wroteMessage = false;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(headerPrefix));
          wroteHeader = true;
          return;
        }

        const batch: string[] = [];
        let batchLength = 0;
        let next: IteratorResult<string>;
        try {
          next = iterator.next();
          while (!next.done) {
            const prefix = wroteMessage ? "," : "";
            batch.push(prefix, next.value);
            batchLength += prefix.length + next.value.length;
            wroteMessage = true;
            if (batchLength >= SESSION_DETAIL_STREAM_BATCH_CHARS) break;
            next = iterator.next();
          }
        } catch (error) {
          try {
            iterator.return?.();
          } catch {}
          controller.error(error);
          return;
        }

        if (next.done) {
          batch.push("]}");
          controller.enqueue(encoder.encode(batch.join("")));
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(batch.join("")));
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
  const window = parseDateWindowRequest(c, "agents", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;
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
  const window = parseDateWindowRequest(c, "projects", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;
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
  const params = searchParams(c);
  const paginationRequested = params.has("limit") || params.has("cursor");
  const sessionQuery = parseSessionQuery(params, KNOWN_AGENT_NAMES, SESSION_PAGE_LIMIT_POLICY);
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("sessions", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
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
  const window = parseDateWindowRequest(c, "sessions", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;

  let sessions: SessionHead[] = [];

  if (sessionQuery.agent.kind === "all") {
    sessions = [...scanResult.sessions];
  } else if (sessionQuery.agent.kind === "known") {
    sessions = [...(scanResult.byAgent[sessionQuery.agent.agentName] ?? [])];
  } else {
    reportInvalidQueryParameter("sessions", "agent", "empty_result");
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

  if (paginationRequested) {
    const page = paginateSessionSnapshot(sessions, {
      cursor: params.get("cursor") ?? undefined,
      limit: sessionQuery.limit.value,
      query: params,
      snapshotIdentity: scanResult.sessions,
      viewIdentity: aliases,
    });
    if (page.kind === "invalid_cursor") {
      reportInvalidQueryParameter("sessions", "cursor", "rejected");
      return c.json({ error: "cursor is invalid for this request" }, 400);
    }
    if (page.kind === "stale_snapshot") {
      return c.json({ error: "session snapshot changed; restart pagination" }, 409);
    }
    return c.json({
      sessions: page.items.map((session) =>
        toSessionListItem(aliases.decorate(session, getSessionHeadReference(session))),
      ),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  return c.json({
    sessions: sessions.map((session) =>
      toSessionListItem(aliases.decorate(session, getSessionHeadReference(session))),
    ),
  });
}

/**
 * Sub-session hits render as 父 › 子, so each one needs its parent's title. The
 * index is built only when some hit actually has a parent — the common query
 * touches no sub-session at all.
 */
function withParentContext(
  results: SearchResult[],
  sessions: SessionHead[],
  aliases: AliasView,
): SearchResult[] {
  if (!results.some((result) => result.session.parent_reference)) return results;

  const byRouteKey = new Map(
    sessions.map((session) => [
      getSessionRouteKey(getSessionAgentKey(session), session.id),
      session,
    ]),
  );

  return results.map((result) => {
    const parentReference = result.session.parent_reference;
    if (!parentReference) return result;
    const parent = byRouteKey.get(formatSessionReference(parentReference));
    if (!parent) return result;
    const reference = normalizeSessionReference(parentReference);
    return { ...result, parent: { reference, title: aliases.get(reference) ?? parent.title } };
  });
}

const ALIAS_SEARCH_RESULT_SHARE = 0.25;

function searchResultKey(result: SearchResult): string {
  return `${result.reference.agentName}\0${result.reference.sessionId}`;
}

function uniqueSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = searchResultKey(result);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeAliasSearchResults(
  rankedResults: SearchResult[],
  aliasResults: SearchResult[],
  limit: number,
): SearchResult[] {
  if (limit <= 0) return [];

  const ranked = uniqueSearchResults(rankedResults);
  const rankedKeys = new Set(ranked.map(searchResultKey));
  const aliases = uniqueSearchResults(aliasResults).filter(
    (result) => !rankedKeys.has(searchResultKey(result)),
  );
  if (ranked.length === 0) return aliases.slice(0, limit);
  if (aliases.length === 0) return ranked.slice(0, limit);

  // Alias hits have no BM25 score. Keep ranked search dominant while reserving
  // a bounded share so local renames remain discoverable.
  const aliasQuota = Math.min(
    limit - 1,
    Math.max(1, Math.floor(limit * ALIAS_SEARCH_RESULT_SHARE)),
  );
  const rankedQuota = limit - aliasQuota;
  return [
    ...ranked.slice(0, rankedQuota),
    ...aliases.slice(0, aliasQuota),
    ...ranked.slice(rankedQuota),
    ...aliases.slice(aliasQuota),
  ].slice(0, limit);
}

export function handleSearchSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const query = c.req.query("q")?.trim() ?? "";
  const scanResult = scanSource.getSnapshot();
  const sessionQuery = parseSessionQuery(searchParams(c), KNOWN_AGENT_NAMES, SEARCH_LIMIT_POLICY);
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("search", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "search", defaults);
  if (window.kind === "rejected") return window.response;
  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("search", "agent", "empty_result");
    return c.json({ results: [] });
  }
  const searchOptions = parseSearchOptions(
    c,
    window,
    {
      agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
      limit: sessionQuery.limit.value,
    },
    projectIdentity,
  );
  const aliases = loadAliasView();
  const results = executeSessionSearch(query, searchOptions, scanResult).map((result) => ({
    ...result,
    session: aliases.decorate(result.session, result.reference),
  }));
  const aliasResults = findAliasSearchResults(query, searchOptions, scanResult, aliases);
  const mergedResults = mergeAliasSearchResults(results, aliasResults, searchOptions.limit ?? 50);
  return c.json({
    results: withParentContext(mergedResults, scanResult.sessions, aliases),
  });
}

export function handleGetFileActivity(c: Context, defaults: SessionListDefaults = {}) {
  const sessionQuery = parseSessionQuery(
    searchParams(c),
    KNOWN_AGENT_NAMES,
    FILE_ACTIVITY_LIMIT_POLICY,
  );
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("file-activity", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "file-activity", defaults);
  if (window.kind === "rejected") return window.response;
  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("file-activity", "agent", "empty_result");
    return c.json({ activity: [] });
  }

  const aliases = loadAliasView();
  return c.json({
    activity: listFileActivity({
      agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
      sessionId: optionalQueryValue(c.req.query("sessionId")),
      projectKind: projectIdentity?.kind,
      projectKey: projectIdentity?.key,
      project: optionalQueryValue(c.req.query("project")),
      cwd: optionalQueryValue(c.req.query("cwd")),
      path: optionalQueryValue(c.req.query("path")),
      kind: parseFileActivityKind(optionalQueryValue(c.req.query("kind"))),
      from: window.from,
      to: window.to,
      limit: sessionQuery.limit.value,
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
    return c.json({ error: "Failed to load session" }, 500);
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

function materializeStoredBookmarks(
  scanSource: ScanResultSource,
  bookmarks: readonly BookmarkRecord[],
  aliases: AliasView,
): BookmarkView[] {
  const snapshot = scanSource.getSnapshot();
  const sessionIndex = getSnapshotAggregation(
    scanSource,
    snapshot.sessions,
    ["bookmark-session-index"],
    () => createSessionIndex(snapshot.sessions),
  );
  return materializeBookmarkViews(bookmarks, {
    liveSessionsByReference: sessionIndex.byRouteKey,
    knownAgentNames: KNOWN_AGENT_NAME_SET,
    resolveCachedSessions: loadCachedSessionHeads,
  }).map((bookmark) => decorateBookmark(bookmark, aliases));
}

export function handleGetBookmarks(c: Context, scanSource: ScanResultSource) {
  return withStorageErrors(
    () => {
      const aliases = loadAliasView();
      const bookmarks = materializeStoredBookmarks(scanSource, listBookmarks(), aliases);
      return c.json({
        bookmarks,
        storageAvailable: true,
      });
    },
    () => c.json({ bookmarks: [], storageAvailable: false }),
  );
}

export async function handlePutBookmark(c: Context) {
  const payload = parseBookmarkReference(await c.req.json().catch(() => null));
  if (!payload) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  return withStorageErrors(
    () => c.json({ bookmark: upsertBookmark(payload), storageAvailable: true }),
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export async function handleImportBookmarks(c: Context, scanSource: ScanResultSource) {
  const payload = await c.req.json().catch(() => null);
  if (!Array.isArray(payload)) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  const bookmarks = payload
    .map((entry) => parseBookmarkImport(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (bookmarks.length !== payload.length) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  return withStorageErrors(
    () => {
      const imported = importBookmarks(bookmarks);
      const views = materializeStoredBookmarks(scanSource, imported, loadAliasView());
      return c.json({ bookmarks: views, storageAvailable: true });
    },
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
  const dateWindow = parseDateWindowRequest(c, "dashboard", defaults);
  if (dateWindow.kind === "rejected") return dateWindow.response;
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

  const compare =
    from == null
      ? undefined
      : { from: addCalendarDays(from, -(days ?? countCalendarDays(from, to))), to: from - 1 };

  const fixedTo = dateWindow.to;
  const aggregate = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "dashboard",
      scope.agent,
      scope.projectKind,
      scope.projectKey,
      from,
      fixedTo ?? startOfCalendarDay(to),
      compare?.from,
      compare?.to,
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
        compare,
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
    modelCost: listModelCostDistribution({
      agent: scope.agent,
      projectKind: scope.projectKind,
      projectKey: scope.projectKey,
      from,
      to,
    }),
    window: { from, to, days, compareFrom: compare?.from, compareTo: compare?.to },
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
