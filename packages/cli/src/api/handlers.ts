import type { Context } from "hono";
import type {
  BookmarkRecord,
  ProjectGroup,
  ScanResult,
  SessionData,
  SessionHead,
  SmartTag,
} from "@codesesh/core";
import type {
  ApiProjectAgentStat,
  ApiProjectGroup,
  AppConfig,
  ScanStatusEvent,
  SearchResult,
} from "@codesesh/core/contract";
import {
  BookmarkStorageUnavailableError,
  createProjectScopeMatcher,
  deleteBookmark,
  getAgentInfoMap,
  classifySessionTags,
  computeIdentity,
  extractSessionFileActivity,
  getSmartTagSourceTimestamp,
  importBookmarks,
  isProjectIdentityKind,
  loadCachedSessionData,
  listFileActivity,
  listSessionFileActivity,
  listCachedProjectGroups,
  listBookmarks,
  parseSearchQuery,
  realFs,
  searchFileActivitySessions,
  searchSessions,
  upsertBookmark,
  matchesProjectScope as sessionMatchesProjectScope,
  matchesProjectIdentity,
  buildDashboard,
  getSessionAgentName,
  getSessionActivityTime,
  getTotalTokens,
  startOfLocalDay,
  type DashboardData,
  type DashboardScope,
  type FileActivityKind,
  type ProjectScopeMatcher,
  type ProjectIdentityRef,
  type SearchOptions,
  type SearchQueryFilters,
} from "@codesesh/core";
import { appLogger } from "../logging.js";

export interface ScanResultSource {
  getSnapshot(): ScanResult;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}

export interface SessionListDefaults {
  from?: number;
  to?: number;
  /** When --days was used, original value — kept for UI "last N days" label */
  days?: number;
}

interface ClientLogPayload {
  event?: unknown;
  data?: unknown;
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

function parseDateParam(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value == null) return fallback;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? fallback : ts;
}

function parseNumberParam(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function searchParams(c: Context): URLSearchParams {
  return new URL(c.req.url ?? "http://localhost/", "http://localhost/").searchParams;
}

function queryValues(params: URLSearchParams, ...names: string[]): string[] {
  return names.flatMap((name) =>
    params
      .getAll(name)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function parseSmartTags(values: string[]): SmartTag[] | undefined {
  const tags = values
    .map((value) => value.toLowerCase())
    .filter((value): value is SmartTag =>
      [
        "bugfix",
        "refactoring",
        "feature-dev",
        "testing",
        "docs",
        "git-ops",
        "build-deploy",
        "exploration",
        "planning",
      ].includes(value),
    );
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

function parseSearchOptions(
  c: Context,
  defaults: SessionListDefaults,
  projectIdentity?: ProjectIdentityRef,
): SearchOptions {
  const params = searchParams(c);
  const limitValue = parseNumberParam(params.get("limit") ?? undefined);
  return {
    agent: optionalQueryValue(params.get("agent") ?? undefined),
    project: optionalQueryValue(params.get("project") ?? undefined),
    projectKind: projectIdentity?.kind,
    projectKey: projectIdentity?.key,
    cwd: optionalQueryValue(params.get("cwd") ?? undefined),
    tags: parseSmartTags(queryValues(params, "tag", "tags", "signal")),
    tools: queryValues(params, "tool", "tools").map((tool) => tool.toLowerCase()),
    file: optionalQueryValue(params.get("file") ?? params.get("path") ?? undefined),
    fileKind: parseFileActivityKind(
      optionalQueryValue(params.get("fileKind") ?? params.get("fileActivity") ?? undefined),
    ),
    costMin: parseNumberParam(params.get("costMin") ?? undefined),
    costMax: parseNumberParam(params.get("costMax") ?? undefined),
    from: parseDateParam(params.get("from") ?? undefined, defaults.from),
    to: parseDateParam(params.get("to") ?? undefined, defaults.to),
    limit: limitValue && limitValue > 0 ? Math.min(limitValue, 100) : 50,
  };
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

function sessionMatchesCostFilter(session: SessionHead, options: SearchOptions): boolean {
  const cost = session.stats.total_cost;
  if (options.costMin != null) {
    if (options.costMinExclusive ? cost <= options.costMin : cost < options.costMin) return false;
  }
  if (options.costMax != null) {
    if (options.costMaxExclusive ? cost >= options.costMax : cost > options.costMax) return false;
  }
  return true;
}

function mergeSearchLists<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function mergeSearchOptions(options: SearchOptions, filters: SearchQueryFilters): SearchOptions {
  return {
    ...options,
    agent: options.agent ?? filters.agent,
    project: options.project ?? filters.project,
    projectKind: options.projectKind ?? filters.projectKind,
    projectKey: options.projectKey ?? filters.projectKey,
    cwd: options.cwd ?? filters.cwd,
    tags: mergeSearchLists(options.tags, filters.tags),
    tools: mergeSearchLists(options.tools, filters.tools),
    file: options.file ?? filters.file,
    fileKind: options.fileKind ?? filters.fileKind,
    costMin: options.costMin ?? filters.costMin,
    costMax: options.costMax ?? filters.costMax,
    costMinExclusive: options.costMinExclusive ?? filters.costMinExclusive,
    costMaxExclusive: options.costMaxExclusive ?? filters.costMaxExclusive,
  };
}

function mergeSearchResults(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const result of results) {
    const key = `${result.agentName}/${result.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) break;
  }

  return merged;
}

function getProjectGroupKey(identityKind: string, identityKey: string): string {
  return `${identityKind}:${identityKey}`;
}

function attachProjectMetrics(
  projects: ProjectGroup[],
  sessions: SessionHead[],
): ApiProjectGroup[] {
  const metrics = new Map<
    string,
    {
      messages: number;
      tokens: number;
      cost: number;
      hasEstimatedCost: boolean;
      agentStats: Map<string, ApiProjectAgentStat>;
    }
  >();

  for (const session of sessions) {
    const identity = session.project_identity;
    if (!identity) continue;
    const key = getProjectGroupKey(identity.kind, identity.key);
    let current = metrics.get(key);
    if (!current) {
      current = {
        messages: 0,
        tokens: 0,
        cost: 0,
        hasEstimatedCost: false,
        agentStats: new Map(),
      };
      metrics.set(key, current);
    }

    const tokens = getTotalTokens(session.stats);
    const cost = session.stats.total_cost ?? 0;
    current.messages += session.stats.message_count;
    current.tokens += tokens;
    current.cost += cost;
    if (session.stats.cost_source === "estimated") current.hasEstimatedCost = true;

    const agentName = getSessionAgentName(session);
    const agent = current.agentStats.get(agentName);
    if (agent) {
      agent.sessions += 1;
      agent.messages += session.stats.message_count;
      agent.tokens += tokens;
      agent.cost += cost;
    } else {
      current.agentStats.set(agentName, {
        name: agentName,
        sessions: 1,
        messages: session.stats.message_count,
        tokens,
        cost,
      });
    }
  }

  return projects.map((project) => {
    const metric = metrics.get(getProjectGroupKey(project.identityKind, project.identityKey));
    return {
      ...project,
      messages: metric?.messages ?? 0,
      tokens: metric?.tokens ?? 0,
      cost: metric?.cost ?? 0,
      cost_source:
        metric && metric.cost > 0
          ? metric.hasEstimatedCost
            ? "estimated"
            : "recorded"
          : undefined,
      agentStats: [...(metric?.agentStats.values() ?? [])].sort((a, b) => b.sessions - a.sessions),
    };
  });
}

function matchesRecentSearchFilters(
  session: SessionHead,
  options: SearchOptions,
  projectScope: ProjectScopeMatcher | null,
): boolean {
  if (options.projectKind || options.projectKey) {
    if (
      !options.projectKind ||
      !options.projectKey ||
      !matchesProjectIdentity(session.project_identity, {
        kind: options.projectKind,
        key: options.projectKey,
      })
    ) {
      return false;
    }
  }
  if (projectScope && !sessionMatchesProjectScope(session, projectScope)) return false;
  if (options.project) {
    const projectNeedle = options.project.toLowerCase();
    const projectText = [
      session.project_identity?.key,
      session.project_identity?.displayName,
      session.directory,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!projectText.includes(projectNeedle)) return false;
  }
  if (options.tags?.length && !options.tags.every((tag) => session.smart_tags?.includes(tag))) {
    return false;
  }
  if (!sessionMatchesCostFilter(session, options)) return false;
  return true;
}

function recentSearchSessions(
  scanResult: ScanResult,
  options: SearchOptions & { limit: number },
): SearchResult[] {
  const projectScope = options.cwd ? createProjectScopeMatcher(options.cwd) : null;
  const entries = options.agent
    ? ([[options.agent, scanResult.byAgent[options.agent] ?? []]] as Array<[string, SessionHead[]]>)
    : Object.entries(scanResult.byAgent);

  return entries
    .flatMap(([agentName, sessions]) =>
      filterSessionsByActivityWindow(sessions, options.from, options.to)
        .filter((session) => matchesRecentSearchFilters(session, options, projectScope))
        .map((session) => ({ agentName, session })),
    )
    .toSorted(
      (a, b) =>
        (b.session.time_updated ?? b.session.time_created) -
        (a.session.time_updated ?? a.session.time_created),
    )
    .slice(0, options.limit)
    .map(({ agentName, session }) => ({
      agentName,
      session,
      snippet: `Recent session · ${session.directory}`,
      matchType: "recent",
    }));
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
  const { from, to } = defaults;
  const counts = Object.fromEntries(
    Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [
      agentName,
      filterSessionsByWindow(sessions, from, to).length,
    ]),
  );
  const info = getAgentInfoMap(counts).filter((agent) => agent.count > 0);
  return c.json(info);
}

export function handleGetProjects(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const { from, to } = defaults;
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
  const scanResult = scanSource.getSnapshot();
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const searchOptions = parseSearchOptions(c, defaults, projectIdentity);
  const parsedQuery = parseSearchQuery(query);
  const mergedSearchOptions = mergeSearchOptions(searchOptions, parsedQuery.filters);
  const textQuery = parsedQuery.text || (parsedQuery.hasQualifiers ? "" : query);
  const needsIndexedSearch = Boolean(
    textQuery ||
    mergedSearchOptions.file ||
    mergedSearchOptions.fileKind ||
    mergedSearchOptions.tools?.length,
  );

  if (!needsIndexedSearch) {
    return c.json({
      results: recentSearchSessions(
        scanResult,
        mergedSearchOptions as SearchOptions & { limit: number },
      ),
    });
  }

  const fileQuery =
    mergedSearchOptions.file ??
    (!parsedQuery.text ? parsedQuery.filters.file : undefined) ??
    (!parsedQuery.hasQualifiers && query ? parsedQuery.text || query : "");
  const results: SearchResult[] = mergeSearchResults(
    [
      ...(fileQuery ? searchFileActivitySessions(fileQuery, mergedSearchOptions) : []),
      ...searchSessions(query, mergedSearchOptions),
    ],
    mergedSearchOptions.limit ?? 50,
  );

  return c.json({ results });
}

function parseFileActivityKind(value: string | undefined): FileActivityKind | undefined {
  if (value === "read" || value === "edit" || value === "write" || value === "delete") {
    return value;
  }
  return undefined;
}

function optionalQueryValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseProjectIdentityFilter(
  kindValue: string | undefined,
  keyValue: string | undefined,
): ProjectIdentityRef | null | undefined {
  const kind = optionalQueryValue(kindValue);
  const key = optionalQueryValue(keyValue);
  if (!kind && !key) return undefined;
  if (!kind || !key || !isProjectIdentityKind(kind)) return null;
  return { kind, key };
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
    }),
  });
}

export async function handleGetSessionData(c: Context, scanSource: ScanResultSource) {
  const startedAt = performance.now();
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
    const head = scanResult.byAgent[agentName]?.find((item) => item.id === sessionId);
    const loadStartedAt = performance.now();
    const cachedData = loadCachedSessionData(agentName, sessionId);
    const cachedMessageCount = cachedData?.stats.message_count ?? 0;
    const cacheHasExpectedMessages =
      cachedData !== null && (cachedData.messages.length > 0 || cachedMessageCount === 0);
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
    return c.json({
      ...data,
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

function resolveDashboardWindow(
  defaults: SessionListDefaults,
  queryDays: string | undefined,
  queryFrom: string | undefined,
  queryTo: string | undefined,
): { from?: number; to: number; days?: number } {
  const now = Date.now();

  const toTs = parseDateParam(queryTo, defaults.to) ?? now;

  // Resolve days (preferred): query, defaults.days, or derive from defaults.from
  const hasQueryDays = queryDays != null && queryDays.trim() !== "";
  const parsedDays = hasQueryDays ? parseInt(queryDays, 10) : NaN;
  let days: number | undefined =
    Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : defaults.days;

  const fromFromQuery = parseDateParam(queryFrom, undefined);
  let fromTs: number;
  if (fromFromQuery != null) {
    fromTs = fromFromQuery;
    days ??= Math.max(1, Math.ceil((toTs - fromTs) / 86400000));
  } else if (parsedDays === 0 || (!hasQueryDays && defaults.days === 0)) {
    days = 0;
    return { to: toTs, days };
  } else if (defaults.from != null) {
    fromTs = defaults.from;
    days ??= Math.max(1, Math.ceil((toTs - fromTs) / 86400000));
  } else if (days && days > 0) {
    fromTs = startOfLocalDay(toTs) - (days - 1) * 86400000;
  } else {
    days = 30;
    fromTs = startOfLocalDay(toTs) - (days - 1) * 86400000;
  }

  return { from: fromTs, to: toTs, days };
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
  const { from, to, days } = resolveDashboardWindow(
    defaults,
    c.req.query("days"),
    c.req.query("from"),
    c.req.query("to"),
  );
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

  return c.json(data);
}
