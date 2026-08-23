import { applySessionWindowChanges, formatSessionReference } from "@codesesh/core/contract";
import {
  hashKey,
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type DashboardData,
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
} from "../lib/session-query-consistency";

interface SessionStoreSnapshot {
  window: AppConfig["window"];
  agents: AgentInfo[];
  sessions: SessionHead[];
  dashboard: DashboardData;
}

export interface SessionProjection {
  sessions: SessionHead[];
}

export interface LiveSessionApplyResult {
  visibleNewSessions: number;
}

interface SnapshotAggregates {
  agents: AgentInfo[];
  dashboard: DashboardData;
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

const EMPTY_AGGREGATES = {
  agents: [] satisfies AgentInfo[],
  dashboard: null,
};
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

async function fetchSnapshotAggregates(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<SnapshotAggregates> {
  const [agents, dashboard] = await Promise.all([
    queryClient.fetchQuery(agentCatalogOptions(window)),
    queryClient.fetchQuery(dashboardQueryOptions(window, {})),
  ]);
  return { agents, dashboard };
}

function sessionProjectionOptions(queryClient: QueryClient, window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.sessionProjection(window),
    staleTime: Infinity,
    queryFn: async ({ signal }): Promise<SessionProjection> => {
      const sessionResult = await fetchSessions(
        { from: window.from, to: window.to },
        { signal },
        {
          onFirstPage(sessions) {
            if (!signal.aborted) {
              queryClient.setQueryData(queryKeys.sessionProjection(window), { sessions });
            }
          },
        },
      );
      return { sessions: sessionResult.sessions };
    },
  });
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

function createSnapshot(
  window: AppConfig["window"],
  aggregates: SnapshotAggregates,
  sessions: SessionHead[],
): SessionStoreSnapshot {
  return { window, agents: aggregates.agents, dashboard: aggregates.dashboard, sessions };
}

async function refreshLiveSnapshotAggregates(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<SnapshotAggregates> {
  const agentOptions = agentCatalogOptions(window);
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: agentOptions.queryKey,
      exact: true,
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.dashboards,
      refetchType: "none",
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
  ]);
  return fetchSnapshotAggregates(queryClient, window);
}

async function refreshLiveProjects(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<void> {
  const options = projectsOptions(window);
  await queryClient.invalidateQueries({
    queryKey: options.queryKey,
    exact: true,
    refetchType: "none",
  });
  await queryClient.fetchQuery(options);
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
  const liveAggregateWindowRef = useRef<AppConfig["window"] | null>(null);
  const liveAggregateRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectionQuery = useQuery({
    ...sessionProjectionOptions(queryClient, window ?? {}),
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
  const dashboard = dashboardQuery.data;
  const querySnapshot =
    window !== null &&
    projectionQuery.data &&
    agentsQuery.data !== undefined &&
    dashboard !== undefined
      ? createSnapshot(
          window,
          { agents: agentsQuery.data, dashboard },
          projectionQuery.data.sessions,
        )
      : null;

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
    const [agentsResult, projectionResult, dashboardResult, projectsResult] = await Promise.all([
      refetchAgents({ cancelRefetch: true }),
      refetchProjection({ cancelRefetch: true }),
      refetchDashboard({ cancelRefetch: true }),
      refetchProjects({ cancelRefetch: true }),
    ]);
    const failure =
      agentsResult.error ?? projectionResult.error ?? dashboardResult.error ?? projectsResult.error;
    if (failure) throw failure;
  }, [refetchAgents, refetchDashboard, refetchProjection, refetchProjects, window]);

  const applyLiveEvent = useCallback(
    async (event: SessionsUpdatedEvent): Promise<LiveSessionApplyResult | null> => {
      if (!window) return null;
      const activeWindow = window;
      const projectionKey = queryKeys.sessionProjection(activeWindow);
      const agentCatalogKey = queryKeys.agentCatalog(activeWindow);
      const dashboardKey = queryKeys.dashboard(activeWindow, {});
      const currentProjection = queryClient.getQueryData<SessionProjection>(projectionKey);
      const currentAgents = queryClient.getQueryData<AgentInfo[]>(agentCatalogKey);
      const currentDashboard = queryClient.getQueryData<DashboardData>(dashboardKey);
      if (!currentProjection || currentAgents === undefined || currentDashboard === undefined) {
        await reload();
        await Promise.all([
          invalidateLiveSessionDerivedQueries(queryClient, event),
          invalidateLiveSessionCollections(queryClient),
        ]);
        return { visibleNewSessions: 0 };
      }

      const projection = applySessionWindowChanges(currentProjection.sessions, {
        changedSessionHeads: event.changedSessionHeads,
        projectionRelatedSessionHeads: event.projectionRelatedSessionHeads,
        projectionSessionOrder: event.projectionSessionOrder,
        removedSessionRefs: event.removedSessionRefs,
        from: activeWindow.from,
        to: activeWindow.to,
      });
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
          refreshLiveProjects(queryClient, activeWindow),
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
    [queryClient, reload, window],
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

  const displayedSnapshot = querySnapshot;
  const agents = displayedSnapshot?.agents ?? EMPTY_AGGREGATES.agents;
  const projectPage = projectsQuery.data ?? EMPTY_PROJECT_PAGE;
  const projects = projectPage.projects;
  const projectsLoading = window === null || projectsQuery.isPending;
  const projectsError =
    window !== null && projectsQuery.isError
      ? projectsQuery.error instanceof Error
        ? projectsQuery.error.message
        : "Unable to load projects."
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
    (agentsQuery.isError && agentsQuery.data === undefined) ||
    (dashboardQuery.isError && dashboardQuery.data === undefined);
  const error = loadFailed ? "Failed to load session data for the selected time window." : null;

  return {
    window: displayedSnapshot?.window ?? null,
    agents,
    sessions: displayedSnapshot?.sessions ?? EMPTY_SESSIONS,
    projects,
    projectPage,
    projectsError,
    projectsLoading,
    dashboard: displayedSnapshot?.dashboard ?? EMPTY_AGGREGATES.dashboard,
    loading: window === null || (!loadFailed && displayedSnapshot === null),
    loadPending:
      window === null ||
      projectionQuery.isFetching ||
      agentsQuery.isFetching ||
      dashboardQuery.isFetching,
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
    retryProjects,
  };
}
