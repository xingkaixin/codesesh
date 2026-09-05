import { t } from "../i18n/translate";
import { applySessionWindowChanges, formatSessionReference } from "@codesesh/core/contract";
import {
  hashKey,
  keepPreviousData,
  queryOptions,
  replaceEqualDeep,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type ApiProjectGroup,
  type ApiProjectPage,
  type SessionHead,
  type SessionsUpdatedEvent,
  fetchAgents,
  fetchProjects,
  fetchSessions,
} from "../lib/api";
import { createAgentCatalog } from "../lib/agents";
import { DASHBOARD_STALE_TIME_MS, dashboardQueryOptions } from "../lib/dashboard-query";
import { queryKeys } from "../lib/query-keys";
import {
  invalidateLiveSessionCollections,
  invalidateLiveSessionDerivedQueries,
  invalidateSessionDerivedQueries,
  PendingSessionProjectionLoads,
} from "../lib/session-query-consistency";

export interface SessionProjection {
  sessions: SessionHead[];
  complete: boolean;
}

export interface LiveSessionApplyResult {
  visibleNewSessions: number;
}

const LIVE_AGGREGATE_REFRESH_INTERVAL_MS = DASHBOARD_STALE_TIME_MS;
const EMPTY_PROJECTS: ApiProjectGroup[] = [];
const EMPTY_PROJECT_PAGE: ApiProjectPage = {
  projects: EMPTY_PROJECTS,
  summary: {
    projects: 0,
    sessions: 0,
    tokens: 0,
    cost: 0,
    latestActivity: null,
  },
};

const EMPTY_AGENTS: AgentInfo[] = [];
const EMPTY_SESSIONS: SessionHead[] = [];

function projectsOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.projectPage(window),
    queryFn: ({ signal }) => fetchProjects(window, { signal }),
    staleTime: LIVE_AGGREGATE_REFRESH_INTERVAL_MS,
    retry: false,
  });
}

function agentCatalogOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.agentCatalog(window),
    queryFn: ({ signal }) => fetchAgents(window, { signal }),
    staleTime: LIVE_AGGREGATE_REFRESH_INTERVAL_MS,
  });
}

interface LoadedSessionProjection extends SessionProjection {
  loadId: number;
  window: AppConfig["window"];
}

function applyProjectionEvent(
  sessions: SessionHead[],
  event: SessionsUpdatedEvent,
  window: AppConfig["window"],
) {
  return applySessionWindowChanges(sessions, {
    changedSessionHeads: event.changedSessionHeads,
    projectionRelatedSessionHeads: event.projectionRelatedSessionHeads,
    projectionSessionOrder: event.projectionSessionOrder,
    removedSessionRefs: event.removedSessionRefs,
    from: window.from,
    to: window.to,
  });
}

async function fetchSessionProjection(
  queryClient: QueryClient,
  signal: AbortSignal,
  window: AppConfig["window"],
  pendingLoads: PendingSessionProjectionLoads,
): Promise<LoadedSessionProjection> {
  const loadId = pendingLoads.begin();
  let readyToCommit = false;
  const project = (sessions: SessionHead[], complete: boolean): SessionProjection => {
    const event = pendingLoads.read(loadId);
    return {
      sessions: event ? applyProjectionEvent(sessions, event, window).sessions : sessions,
      complete,
    };
  };
  try {
    const result = await fetchSessions(
      { from: window.from, to: window.to },
      { signal },
      {
        onFirstPage(sessions) {
          if (!signal.aborted) {
            queryClient.setQueryData<SessionProjection>(
              queryKeys.sessionProjection(window),
              (previous) => previous ?? project(sessions, false),
            );
          }
        },
      },
    );
    signal.throwIfAborted();
    readyToCommit = true;
    return {
      sessions: result.sessions,
      complete: true,
      loadId,
      window,
    };
  } finally {
    if (!readyToCommit) pendingLoads.cancel(loadId);
  }
}

function commitSessionProjection(
  projection: SessionProjection,
  pendingLoads: PendingSessionProjectionLoads,
): SessionProjection {
  if (!("loadId" in projection) || !("window" in projection)) return projection;
  const loaded = projection as LoadedSessionProjection;
  const event = pendingLoads.complete(loaded.loadId);
  return {
    sessions: event
      ? applyProjectionEvent(loaded.sessions, event, loaded.window).sessions
      : loaded.sessions,
    complete: loaded.complete,
  };
}

function removeOtherSessionProjections(
  queryClient: QueryClient,
  activeWindow: AppConfig["window"],
): void {
  const activeProjectionHash = hashKey(queryKeys.sessionProjection(activeWindow));
  queryClient.removeQueries({
    queryKey: queryKeys.sessionProjections,
    predicate: (query) => query.queryHash !== activeProjectionHash,
  });
}

async function refreshLiveSnapshotAggregates(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<void> {
  const agentOptions = agentCatalogOptions(window);
  await Promise.all([
    queryClient.invalidateQueries(
      { queryKey: agentOptions.queryKey, exact: true, refetchType: "active" },
      { throwOnError: true, cancelRefetch: false },
    ),
    queryClient.invalidateQueries(
      { queryKey: queryKeys.dashboards, refetchType: "active" },
      { throwOnError: true, cancelRefetch: false },
    ),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
  ]);
}

async function refreshProjectQueries(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<void> {
  await queryClient.invalidateQueries(
    { queryKey: queryKeys.projectWindow(window), refetchType: "active" },
    { cancelRefetch: false },
  );
  const error = queryClient.getQueryState(queryKeys.projectPage(window))?.error;
  if (error) throw error;
}

function liveAggregateRefreshDelay(queryClient: QueryClient, window: AppConfig["window"]): number {
  const states = [
    queryClient.getQueryState(agentCatalogOptions(window).queryKey),
    queryClient.getQueryState(dashboardQueryOptions(window, {}).queryKey),
    queryClient.getQueryState(projectsOptions(window).queryKey),
  ];
  if (states.some((state) => !state || state.data === undefined || state.isInvalidated)) return 0;
  const oldestUpdate = Math.min(...states.map((state) => state!.dataUpdatedAt));
  return Math.max(0, LIVE_AGGREGATE_REFRESH_INTERVAL_MS - (Date.now() - oldestUpdate));
}

function sameWindow(
  left: AppConfig["window"] | null | undefined,
  right: AppConfig["window"] | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.days === right.days &&
    left.from === right.from &&
    left.to === right.to
  );
}

export function useSessionStore(window: AppConfig["window"] | null) {
  const queryClient = useQueryClient();
  const pendingProjectionLoads = useRef(new PendingSessionProjectionLoads()).current;
  const liveAggregateWindowRef = useRef<AppConfig["window"] | null>(null);
  const liveAggregateRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectionQuery = useQuery<SessionProjection>({
    queryKey: queryKeys.sessionProjection(window ?? {}),
    staleTime: Infinity,
    structuralSharing: (_previous, next) =>
      replaceEqualDeep(
        _previous,
        commitSessionProjection(next as SessionProjection, pendingProjectionLoads),
      ),
    queryFn: ({ signal }): Promise<SessionProjection> =>
      fetchSessionProjection(queryClient, signal, window ?? {}, pendingProjectionLoads),
    enabled: window !== null,
  });
  const agentsQuery = useQuery({
    ...agentCatalogOptions(window ?? {}),
    enabled: window !== null,
  });
  const dashboardQuery = useQuery({
    ...dashboardQueryOptions(window ?? {}, {}),
    enabled: window !== null,
  });
  const projectsQuery = useQuery({
    ...projectsOptions(window ?? {}),
    enabled: window !== null,
    placeholderData: keepPreviousData,
  });
  const refetchProjection = projectionQuery.refetch;
  const refetchAgents = agentsQuery.refetch;
  const refetchDashboard = dashboardQuery.refetch;
  const refetchProjects = projectsQuery.refetch;
  const hasSessionData =
    window !== null && projectionQuery.data !== undefined && agentsQuery.data !== undefined;

  useEffect(() => {
    if (window) removeOtherSessionProjections(queryClient, window);
  }, [queryClient, window]);

  useEffect(
    () => () => {
      if (liveAggregateRefreshTimerRef.current) {
        clearTimeout(liveAggregateRefreshTimerRef.current);
        liveAggregateRefreshTimerRef.current = null;
      }
    },
    [window],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!window) return;
    const [agentsResult, projectionResult, dashboardResult] = await Promise.all([
      refetchAgents({ cancelRefetch: true }),
      refetchProjection({ cancelRefetch: true }),
      refetchDashboard({ cancelRefetch: true }),
      refreshProjectQueries(queryClient, window),
    ]);
    const failure = agentsResult.error ?? projectionResult.error ?? dashboardResult.error;
    if (failure) throw failure;
  }, [queryClient, refetchAgents, refetchDashboard, refetchProjection, window]);

  const applyLiveEvent = useCallback(
    async (event: SessionsUpdatedEvent): Promise<LiveSessionApplyResult | null> => {
      if (!window) return null;
      const activeWindow = window;
      pendingProjectionLoads.record(event);
      const projectionKey = queryKeys.sessionProjection(activeWindow);
      const agentCatalogKey = queryKeys.agentCatalog(activeWindow);
      const currentProjection = queryClient.getQueryData<SessionProjection>(projectionKey);
      const currentAgents = queryClient.getQueryData<AgentInfo[]>(agentCatalogKey);
      if (!currentProjection || currentAgents === undefined) {
        await reload();
        await Promise.all([
          invalidateLiveSessionDerivedQueries(queryClient, event),
          invalidateLiveSessionCollections(queryClient),
        ]);
        return { visibleNewSessions: 0 };
      }

      const projection = applyProjectionEvent(currentProjection.sessions, event, activeWindow);
      const visibleSessionKeys = new Set(
        projection.sessions.map((session) => formatSessionReference(session.reference)),
      );
      const previousSessionKeys = new Set(
        currentProjection.sessions.map((session) => formatSessionReference(session.reference)),
      );
      const visibleNewSessions = event.newSessionRefs.filter((reference) => {
        const key = formatSessionReference(reference);
        return !previousSessionKeys.has(key) && visibleSessionKeys.has(key);
      }).length;
      console.debug("live.session_projection", {
        window_from: activeWindow.from,
        window_to: activeWindow.to,
        before_sessions: currentProjection.sessions.length,
        changed_sessions: event.changedSessionHeads.length,
        projection_related_sessions: event.projectionRelatedSessionHeads?.length ?? 0,
        removed_sessions: event.removedSessionRefs.length,
        after_sessions: projection.sessions.length,
        visible_added_sessions: projection.visibleAddedSessions,
        visible_removed_sessions: projection.visibleRemovedSessions,
        visible_new_sessions: visibleNewSessions,
      });
      queryClient.setQueryData<SessionProjection>(projectionKey, {
        ...currentProjection,
        sessions: projection.sessions,
      });
      await invalidateLiveSessionDerivedQueries(queryClient, event);
      const forceAggregateRefresh = !sameWindow(liveAggregateWindowRef.current, activeWindow);
      const refreshAggregates = () => {
        liveAggregateRefreshTimerRef.current = null;
        void Promise.all([
          refreshLiveSnapshotAggregates(queryClient, activeWindow),
          refreshProjectQueries(queryClient, activeWindow),
        ])
          .then(() => {
            liveAggregateWindowRef.current = activeWindow;
          })
          .catch(() => undefined);
      };
      if (forceAggregateRefresh) {
        refreshAggregates();
      } else if (!liveAggregateRefreshTimerRef.current) {
        const delay = liveAggregateRefreshDelay(queryClient, activeWindow);
        if (delay === 0) refreshAggregates();
        else liveAggregateRefreshTimerRef.current = setTimeout(refreshAggregates, delay);
      }
      return { visibleNewSessions };
    },
    [pendingProjectionLoads, queryClient, reload, window],
  );

  const resyncLiveState = useCallback(async (): Promise<void> => {
    if (!window) return;
    await reload();
    await invalidateSessionDerivedQueries(queryClient);
  }, [queryClient, reload, window]);

  const retryLoad = useCallback(async (): Promise<void> => {
    if (!window) return;
    try {
      await reload();
    } catch {
      // reload already exposed the failure; rethrowing would only leak an
      // unhandled rejection from the button handler.
    }
  }, [reload, window]);

  const retrySessions = useCallback(async (): Promise<void> => {
    if (!window) return;
    await refetchProjection({ cancelRefetch: true });
  }, [refetchProjection, window]);

  const agents = hasSessionData ? agentsQuery.data : EMPTY_AGENTS;
  const projectPage = projectsQuery.data ?? EMPTY_PROJECT_PAGE;
  const projects = projectPage.projects;
  const projectsLoading = window === null || projectsQuery.isPending;
  const projectsError =
    window !== null && projectsQuery.isError
      ? projectsQuery.error instanceof Error
        ? projectsQuery.error.message
        : t("Unable to load projects.")
      : null;
  const retryProjects = useCallback(async (): Promise<void> => {
    if (!window) return;
    await refetchProjects({ cancelRefetch: true });
  }, [refetchProjects, window]);
  const agentCatalog = useMemo(() => createAgentCatalog(agents), [agents]);
  const validAgentKeys = useMemo(
    () => new Set(agentCatalog.active.map((agent) => agent.name.toLowerCase())),
    [agentCatalog.active],
  );
  const loadFailed =
    (projectionQuery.isError && projectionQuery.data === undefined) ||
    (agentsQuery.isError && agentsQuery.data === undefined);
  const error = loadFailed ? t("Failed to load session data for the selected time window.") : null;

  return {
    window: hasSessionData ? window : null,
    agents,
    sessions: hasSessionData ? projectionQuery.data.sessions : EMPTY_SESSIONS,
    sessionsLoading: projectionQuery.isFetching,
    sessionsError:
      projectionQuery.data !== undefined &&
      (projectionQuery.isError || (!projectionQuery.data.complete && !projectionQuery.isFetching))
        ? t("Session loading failed. Displayed sessions may be incomplete or out of date.")
        : null,
    projects,
    projectPage,
    projectsError,
    projectsLoading,
    dashboard: window !== null ? (dashboardQuery.data ?? null) : null,
    loading: window === null || (!loadFailed && !hasSessionData),
    loadPending: window === null || projectionQuery.isFetching || agentsQuery.isFetching,
    error,
    version: projectionQuery.dataUpdatedAt,
    activeAgents: agentCatalog.active,
    agentCatalog,
    validAgentKeys,
    agentNameMap: agentCatalog.displayNameByKey,
    reload,
    applyLiveEvent,
    resyncLiveState,
    retryLoad,
    retrySessions,
    retryProjects,
  };
}
