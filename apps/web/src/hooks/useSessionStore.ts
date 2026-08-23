import { applySessionWindowChanges, formatSessionReference } from "@codesesh/core/contract";
import {
  hashKey,
  isCancelledError,
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type DashboardData,
  type ApiProjectGroup,
  type ApiProjectPage,
  type SessionHead,
  type SessionsUpdatedEvent,
  fetchAgents,
  fetchConfig,
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
  window: AppConfig["window"];
  sessions: SessionHead[];
}

export interface LiveSessionApplyResult {
  visibleNewSessions: number;
}

export interface SessionReloadResult {
  agentCount: number;
  sessionCount: number;
}

interface SnapshotAggregates {
  agents: AgentInfo[];
  dashboard: DashboardData;
}

interface ActiveLoadRequest {
  window: AppConfig["window"];
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

function sessionProjectionOptions(
  window: AppConfig["window"],
  onFirstPage?: (projection: SessionProjection) => void,
) {
  return queryOptions({
    queryKey: queryKeys.sessionProjection(window),
    staleTime: Infinity,
    queryFn: async ({ signal }): Promise<SessionProjection> => {
      const sessionResult = await fetchSessions(
        { from: window.from, to: window.to },
        { signal },
        {
          onFirstPage(sessions) {
            onFirstPage?.({ window, sessions });
          },
        },
      );
      return { window, sessions: sessionResult.sessions };
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

async function fetchLiveSnapshotAggregates(
  queryClient: QueryClient,
  window: AppConfig["window"],
  forceRefresh: boolean,
): Promise<SnapshotAggregates> {
  const agentOptions = agentCatalogOptions(window);
  const dashboardOptions = dashboardQueryOptions(window, {});
  const agentState = queryClient.getQueryState(agentOptions.queryKey);
  const dashboardState = queryClient.getQueryState(dashboardOptions.queryKey);
  const needsRefresh =
    forceRefresh ||
    !agentState ||
    agentState.data === undefined ||
    agentState.isInvalidated ||
    Date.now() - agentState.dataUpdatedAt >= LIVE_AGGREGATE_REFRESH_INTERVAL_MS ||
    !dashboardState ||
    dashboardState.data === undefined ||
    dashboardState.isInvalidated ||
    Date.now() - dashboardState.dataUpdatedAt >= LIVE_AGGREGATE_REFRESH_INTERVAL_MS;
  if (needsRefresh) {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: agentOptions.queryKey,
        exact: true,
        refetchType: "none",
      }),
      invalidateLiveSessionCollections(queryClient),
    ]);
  }
  return fetchSnapshotAggregates(queryClient, window);
}

function refreshLiveProjects(queryClient: QueryClient, window: AppConfig["window"]): void {
  const options = projectsOptions(window);
  const state = queryClient.getQueryState(options.queryKey);
  const needsRefresh =
    !state ||
    state.data === undefined ||
    state.isInvalidated ||
    Date.now() - state.dataUpdatedAt >= LIVE_AGGREGATE_REFRESH_INTERVAL_MS;
  if (!needsRefresh) return;
  void queryClient.fetchQuery(options).catch(() => undefined);
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

export function useSessionStore() {
  const queryClient = useQueryClient();
  const [requestedWindow, setRequestedWindow] = useState<AppConfig["window"] | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  const activeRequestRef = useRef<ActiveLoadRequest | null>(null);
  const liveAggregateWindowRef = useRef<AppConfig["window"] | null>(null);
  const configQuery = useQuery({
    queryKey: queryKeys.config,
    retry: 2,
    retryDelay: 250,
    queryFn: async ({ signal }) => {
      try {
        return await fetchConfig({ signal });
      } catch (error) {
        if (!signal.aborted) console.error("Failed to load config:", error);
        throw error;
      }
    },
  });
  const projectionQuery = useQuery({
    ...sessionProjectionOptions(requestedWindow ?? {}),
    enabled: false,
  });
  const agentsQuery = useQuery({
    ...agentCatalogOptions(requestedWindow ?? {}),
    enabled: false,
  });
  const dashboardQuery = useQuery({
    ...dashboardQueryOptions(requestedWindow ?? {}, {}),
    enabled: false,
  });
  const projectsQuery = useQuery({
    ...projectsOptions(requestedWindow ?? {}),
    enabled: requestedWindow !== null,
    placeholderData: keepPreviousData,
  });
  const configFailed = configQuery.isError;
  const refetchConfig = configQuery.refetch;
  const dashboard = dashboardQuery.data;
  const querySnapshot =
    requestedWindow !== null &&
    projectionQuery.data &&
    agentsQuery.data !== undefined &&
    dashboard !== undefined &&
    sameWindow(projectionQuery.data.window, requestedWindow)
      ? createSnapshot(
          requestedWindow,
          { agents: agentsQuery.data, dashboard },
          projectionQuery.data.sessions,
        )
      : null;

  const reload = useCallback(
    async (window: AppConfig["window"]): Promise<SessionReloadResult | null> => {
      const request = { window };
      activeRequestRef.current = request;
      liveAggregateWindowRef.current = null;
      setRequestedWindow(window);
      setReloadFailed(false);
      try {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: queryKeys.sessionProjections }),
          queryClient.cancelQueries({ queryKey: queryKeys.agentCatalogs }),
          queryClient.cancelQueries({ queryKey: queryKeys.projects }),
        ]);
        removeOtherSessionProjections(queryClient, window);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessionProjection(window),
            exact: true,
            refetchType: "none",
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.agentCatalog(window),
            exact: true,
            refetchType: "none",
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.dashboard(window, {}),
            exact: true,
            refetchType: "none",
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.projectPage(window),
            exact: true,
            refetchType: "none",
          }),
        ]);
        void queryClient.fetchQuery(projectsOptions(window)).catch(() => undefined);
        const [aggregates, projection] = await Promise.all([
          fetchSnapshotAggregates(queryClient, window),
          queryClient.fetchQuery(
            sessionProjectionOptions(window, (firstPageProjection) => {
              if (activeRequestRef.current !== request) return;
              queryClient.setQueryData(queryKeys.sessionProjection(window), firstPageProjection);
            }),
          ),
        ]);
        return {
          agentCount: aggregates.agents.length,
          sessionCount: projection.sessions.length,
        };
      } catch (error) {
        if (isCancelledError(error)) return null;
        if (activeRequestRef.current === request) setReloadFailed(true);
        throw error;
      }
    },
    [queryClient],
  );

  const applyLiveEvent = useCallback(
    async (event: SessionsUpdatedEvent): Promise<LiveSessionApplyResult | null> => {
      const activeRequest = activeRequestRef.current;
      if (!activeRequest) return null;
      const { window: activeWindow } = activeRequest;
      const projectionKey = queryKeys.sessionProjection(activeWindow);
      const agentCatalogKey = queryKeys.agentCatalog(activeWindow);
      const dashboardKey = queryKeys.dashboard(activeWindow, {});
      const currentProjection = queryClient.getQueryData<SessionProjection>(projectionKey);
      const currentAgents = queryClient.getQueryData<AgentInfo[]>(agentCatalogKey);
      const currentDashboard = queryClient.getQueryData<DashboardData>(dashboardKey);
      if (!currentProjection || currentAgents === undefined || currentDashboard === undefined) {
        const refreshed = await reload(activeWindow);
        await Promise.all([
          invalidateLiveSessionDerivedQueries(queryClient, event),
          invalidateLiveSessionCollections(queryClient),
        ]);
        return refreshed ? { visibleNewSessions: 0 } : null;
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
      refreshLiveProjects(queryClient, activeWindow);
      const forceAggregateRefresh = !sameWindow(liveAggregateWindowRef.current, activeWindow);
      void fetchLiveSnapshotAggregates(queryClient, activeWindow, forceAggregateRefresh)
        .then(() => {
          const latestRequest = activeRequestRef.current;
          if (latestRequest === activeRequest) {
            liveAggregateWindowRef.current = activeWindow;
          }
        })
        .catch(() => undefined);
      return { visibleNewSessions };
    },
    [queryClient, reload],
  );

  const resyncLiveState = useCallback(async (): Promise<void> => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    await reload(activeRequest.window);
    await invalidateSessionDerivedQueries(queryClient);
  }, [queryClient, reload]);

  const retryLoad = useCallback(async (): Promise<void> => {
    const activeRequest = activeRequestRef.current;
    if (configFailed || !activeRequest) {
      await refetchConfig();
      return;
    }
    try {
      await reload(activeRequest.window);
    } catch {
      // reload already exposed the failure; rethrowing would only leak an
      // unhandled rejection from the button handler.
    }
  }, [configFailed, refetchConfig, reload]);

  const displayedSnapshot = sameWindow(querySnapshot?.window, requestedWindow)
    ? querySnapshot
    : null;
  const agents = displayedSnapshot?.agents ?? EMPTY_AGGREGATES.agents;
  const projectPage = projectsQuery.data ?? EMPTY_PROJECT_PAGE;
  const projects = projectPage.projects;
  const projectsLoading = requestedWindow === null || projectsQuery.isPending;
  const projectsError =
    requestedWindow !== null && projectsQuery.isError
      ? projectsQuery.error instanceof Error
        ? projectsQuery.error.message
        : "Unable to load projects."
      : null;
  const retryProjects = useCallback(async (): Promise<void> => {
    if (!activeRequestRef.current) return;
    await projectsQuery.refetch({ cancelRefetch: true });
  }, [projectsQuery]);
  const agentCatalog = useMemo(() => createAgentCatalog(agents), [agents]);
  const validAgentKeys = useMemo(
    () => new Set(agentCatalog.active.map((agent) => agent.name.toLowerCase())),
    [agentCatalog.active],
  );
  const error = configQuery.isError
    ? "Failed to load configuration. The CLI may be restarting or unavailable."
    : reloadFailed
      ? "Failed to load session data for the selected time window."
      : null;

  return {
    config: configQuery.data ?? null,
    window: displayedSnapshot?.window ?? null,
    agents,
    sessions: displayedSnapshot?.sessions ?? EMPTY_SESSIONS,
    projects,
    projectPage,
    projectsError,
    projectsLoading,
    dashboard: displayedSnapshot?.dashboard ?? EMPTY_AGGREGATES.dashboard,
    loading:
      configQuery.isPending ||
      (!configQuery.isError &&
        (requestedWindow === null || (!reloadFailed && displayedSnapshot === null))),
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
