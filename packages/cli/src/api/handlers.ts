import type { Context } from "hono";
import type { IdentifiedSessionHead, SessionHead, SmartTag } from "@codesesh/core/runtime";
import {
  addCalendarDays,
  countCalendarDays,
  type SessionTree,
  type AppConfig,
  type SessionReference,
  startOfCalendarDay,
} from "@codesesh/core/contract";
import {
  attachProjectMetricsFromTree,
  createProjectScopeMatcherFromIdentity,
  getAgentInfoMap,
  getAnalyticsRevision,
  mergeSearchQueryOptions,
  executeSessionSearch,
  getSearchProjectDirectory,
  listDashboardCostFacts,
  listFileActivity,
  listCachedProjectGroups,
  materializeSessionDetailResponse,
  matchesProjectScope as sessionMatchesProjectScope,
  matchesProjectIdentity,
  normalizeProjectDirectory,
  PROJECT_IDENTITY_RESOLVER_REVISION,
  summarizeProjects,
  buildDashboard,
  type DashboardData,
  type DashboardScope,
  type ProjectScopeMatcher,
} from "@codesesh/core/runtime";
import { appLogger } from "../logging.js";
import {
  ProjectIdentityQueueFullError,
  ProjectIdentityRequestAbortedError,
  type ProjectIdentityResolver,
} from "../project-identity-resolver.js";
import { resolveTimeWindow } from "../time-window-resolution.js";
import {
  filterSessionsByActivityWindow,
  FILE_ACTIVITY_LIMIT_POLICY,
  parseDateWindow,
  parseFileActivityKind,
  parseProjectIdentityFilter,
  parseLimit,
  parseSessionQuery,
  parseSearchOptions,
  optionalQueryValue,
  PROJECT_PAGE_LIMIT_POLICY,
  searchParams,
  SEARCH_LIMIT_POLICY,
  SESSION_PAGE_LIMIT_POLICY,
  type SessionListDefaults,
} from "./query-params.js";
import { paginateSnapshot } from "./snapshot-pagination.js";
import type { ScanResultSource, ScanStatusSource } from "./scan-sources.js";
import {
  getDashboardCostFacts,
  getDashboardStorageAggregation,
  getSnapshotAggregation,
  getSnapshotSessionTree,
} from "./snapshot-aggregation.js";
import { sanitizeClientLogData } from "./request-payloads.js";
import { createSessionDetailJsonResponse } from "./session-detail-stream.js";
import { mergeAliasSearchResults, withParentContext } from "./search-result-merge.js";
import {
  decorateFileActivity,
  findAliasSearchResults,
  loadAliasView,
} from "./session-aliases-view.js";

export type { SessionListDefaults };

export type { ScanResultSource, ScanStatusSource } from "./scan-sources.js";

const KNOWN_AGENT_NAMES = getAgentInfoMap({}).map((agent) => agent.name);
export const KNOWN_AGENT_NAME_SET = new Set(KNOWN_AGENT_NAMES);

async function resolveProjectScope(
  cwd: string,
  sessions: readonly IdentifiedSessionHead[],
  resolver: ProjectIdentityResolver | undefined,
  signal: AbortSignal,
): Promise<ProjectScopeMatcher> {
  const normalizedCwd = normalizeProjectDirectory(cwd);
  const matchingSession = sessions.find(
    (session) =>
      normalizeProjectDirectory(session.directory) === normalizedCwd &&
      session.project_identity_resolver_revision === PROJECT_IDENTITY_RESOLVER_REVISION &&
      Boolean(session.project_identity_input_signature),
  );
  if (matchingSession) {
    return createProjectScopeMatcherFromIdentity(cwd, matchingSession.project_identity);
  }
  if (!resolver) throw new Error("Project identity resolver is unavailable");

  const projection = await resolver.resolve(cwd, signal);
  return createProjectScopeMatcherFromIdentity(cwd, projection.identity);
}

function reportProjectScopeResolutionFailure(endpoint: string, error: unknown): void {
  appLogger.warn("api.project_scope.unavailable", {
    endpoint,
    error: error instanceof Error ? error.message : String(error),
  });
}

function projectScopeResolutionFailureResponse(c: Context, endpoint: string, error: unknown) {
  if (error instanceof ProjectIdentityRequestAbortedError) throw error;
  reportProjectScopeResolutionFailure(endpoint, error);
  if (error instanceof ProjectIdentityQueueFullError) {
    return c.json({ error: "Project scope busy; retry later" }, 429);
  }
  return c.json({ error: "Project scope unavailable" }, 503);
}

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

interface ClientLogPayload {
  event?: unknown;
  data?: unknown;
}

function toSessionListItem(session: IdentifiedSessionHead): IdentifiedSessionHead {
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
  return session.reference;
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
  const params = searchParams(c);
  const limit = parseLimit(params.get("limit"), PROJECT_PAGE_LIMIT_POLICY);
  if (limit.kind === "invalid") {
    reportInvalidQueryParameter("projects", "limit", "rejected");
    return c.json({ error: limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "projects", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;
  const analyticsRevision = getAnalyticsRevision();
  const catalog = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    ["projects", from, to, analyticsRevision],
    () => {
      const tree = getSnapshotSessionTree(scanSource, scanResult.sessions);
      const costFacts = listDashboardCostFacts({ from, to, includeModelCosts: false });
      const projects = attachProjectMetricsFromTree(
        listCachedProjectGroups(scanResult.sessions),
        tree,
        from,
        to,
        costFacts,
      ).filter(
        (project) =>
          project.sessionCount > 0 ||
          project.messages > 0 ||
          project.tokens > 0 ||
          project.cost > 0,
      );
      return { projects, summary: summarizeProjects(projects) };
    },
  );
  const projects = projectIdentity
    ? catalog.projects.filter(
        (project) =>
          project.identityKind === projectIdentity.kind &&
          project.identityKey === projectIdentity.key,
      )
    : catalog.projects;
  const page = paginateSnapshot(projects, {
    cursor: params.get("cursor") ?? undefined,
    limit: limit.value,
    query: params,
    snapshotIdentity: scanResult.sessions,
    viewIdentity: catalog.projects,
  });
  if (page.kind === "invalid_cursor") {
    reportInvalidQueryParameter("projects", "cursor", "rejected");
    return c.json({ error: "cursor is invalid for this request" }, 400);
  }
  if (page.kind === "stale_snapshot") {
    return c.json({ error: "project snapshot changed; restart pagination" }, 409);
  }
  return c.json({
    projects: page.items,
    summary: projectIdentity ? summarizeProjects(projects) : catalog.summary,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  });
}

export async function handleGetSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
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
  const cwd = optionalQueryValue(c.req.query("cwd"));
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

  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd && !projectIdentity) {
    try {
      projectScope = await resolveProjectScope(
        cwd,
        scanResult.sessions,
        resolver,
        c.req.raw.signal,
      );
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "sessions", error);
    }
  }

  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("sessions", "agent", "empty_result");
  }

  const agentFilter =
    sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : sessionQuery.agent.kind;
  let sessions = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "sessions",
      agentFilter,
      projectIdentity?.kind,
      projectIdentity?.key,
      projectScope?.identity.kind,
      projectScope?.identity.key,
      projectScope?.path,
      tag,
      from,
      to,
    ],
    () => {
      let filtered =
        sessionQuery.agent.kind === "all"
          ? scanResult.sessions
          : sessionQuery.agent.kind === "known"
            ? (scanResult.byAgent[sessionQuery.agent.agentName] ?? [])
            : [];

      if (projectIdentity) {
        filtered = filtered.filter((session) =>
          matchesProjectIdentity(session.project_identity, projectIdentity),
        );
      } else if (projectScope) {
        filtered = filtered.filter((session) => sessionMatchesProjectScope(session, projectScope));
      }
      filtered = filterSessionsByActivityWindow(filtered, from, to);
      return tag
        ? filtered.filter((session) => session.smart_tags?.includes(tag as SmartTag))
        : filtered;
    },
  );

  const aliases = loadAliasView();
  if (q) {
    sessions = sessions.filter((session) => {
      const alias = aliases.get(getSessionHeadReference(session));
      return session.title.toLowerCase().includes(q) || alias?.toLowerCase().includes(q);
    });
  }

  if (paginationRequested) {
    const page = paginateSnapshot(sessions, {
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

export async function handleSearchSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
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
  const searchRequestOptions = parseSearchOptions(
    c,
    window,
    {
      agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
      limit: sessionQuery.limit.value,
    },
    projectIdentity,
  );
  const cwd = getSearchProjectDirectory(query, searchRequestOptions);
  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd) {
    try {
      projectScope = await resolveProjectScope(
        cwd,
        scanResult.sessions,
        resolver,
        c.req.raw.signal,
      );
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "search", error);
    }
  }
  const { cwd: _cwd, ...searchOptions } = searchRequestOptions;
  const resolvedSearchOptions = projectScope ? { ...searchOptions, projectScope } : searchOptions;
  const aliases = loadAliasView();
  let sessionTree: SessionTree | undefined;
  const getSessionTree = () =>
    (sessionTree ??= getSnapshotSessionTree(scanSource, scanResult.sessions));
  const effectiveSearchOptions = mergeSearchQueryOptions(query, resolvedSearchOptions).options;
  const searchContext =
    effectiveSearchOptions.costMin != null || effectiveSearchOptions.costMax != null
      ? { sessionTree: getSessionTree() }
      : undefined;
  const searchResults = searchContext
    ? executeSessionSearch(query, resolvedSearchOptions, scanResult, searchContext)
    : executeSessionSearch(query, resolvedSearchOptions, scanResult);
  const results = searchResults.map((result) => ({
    ...result,
    session: aliases.decorate(result.session, result.reference),
  }));
  const aliasResults = findAliasSearchResults(
    query,
    resolvedSearchOptions,
    scanResult,
    aliases,
    searchContext,
  );
  const mergedResults = mergeAliasSearchResults(
    results,
    aliasResults,
    resolvedSearchOptions.limit ?? 50,
  );
  return c.json({
    results: withParentContext(mergedResults, getSessionTree, aliases),
  });
}

export async function handleGetFileActivity(
  c: Context,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
) {
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

  const cwd = optionalQueryValue(c.req.query("cwd"));
  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd) {
    try {
      projectScope = await resolveProjectScope(cwd, [], resolver, c.req.raw.signal);
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "file-activity", error);
    }
  }

  const aliases = loadAliasView();
  return c.json({
    activity: listFileActivity({
      agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
      sessionId: optionalQueryValue(c.req.query("sessionId")),
      projectKind: projectIdentity?.kind,
      projectKey: projectIdentity?.key,
      project: optionalQueryValue(c.req.query("project")),
      projectScope,
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
    const reference = {
      agentName,
      sessionId,
    };
    const messageCursor = optionalQueryValue(c.req.query("messageCursor"));
    const result = materializeSessionDetailResponse(
      scanSource.getSnapshot(),
      reference,
      messageCursor ? { messageCursor } : {},
    );
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
      sent_messages:
        result.status === "found-json" ? result.sentMessageCount : result.data.messages.length,
      message_update: result.data.message_update ?? "reset",
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
  const cacheTo = fixedTo ?? startOfCalendarDay(to);
  const analyticsRevision = getAnalyticsRevision();
  const costFacts = getDashboardCostFacts(
    scanSource,
    scanResult.sessions,
    compare?.from ?? from,
    to,
    cacheTo,
    analyticsRevision,
  );
  const aggregate = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "dashboard",
      scope.agent,
      scope.projectKind,
      scope.projectKey,
      from,
      cacheTo,
      compare?.from,
      compare?.to,
      analyticsRevision,
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
        costFacts,
      });
    },
  );

  const storageAggregation = getDashboardStorageAggregation(
    scanSource,
    scanResult.sessions,
    scope,
    from,
    to,
    cacheTo,
    analyticsRevision,
  );
  const data: DashboardData = {
    ...aggregate,
    ...storageAggregation,
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
