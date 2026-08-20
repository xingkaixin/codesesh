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
import { useCallback, useMemo, useReducer, useRef } from "react";
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
  fetchDashboard,
  fetchProjects,
  fetchSessions,
} from "../lib/api";
import { createAgentCatalog } from "../lib/agents";
import { queryKeys } from "../lib/query-keys";
import {
  invalidateLiveSessionCollections,
  invalidateLiveSessionDerivedQueries,
  invalidateSessionDerivedQueries,
} from "../lib/session-query-consistency";
import {
  INITIAL_SESSION_STORE_LOAD_STATE,
  reduceSessionStoreLoad,
} from "./session-store-load-state";

export interface SessionStoreSnapshot {
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
  snapshot: SessionStoreSnapshot;
  visibleNewSessions: number;
}

interface SnapshotAggregates {
  window: AppConfig["window"];
  agents: AgentInfo[];
  dashboard: DashboardData;
}

interface ActiveLoadRequest {
  requestId: number;
  window: AppConfig["window"];
}

const LIVE_AGGREGATE_REFRESH_INTERVAL_MS = 2_000;
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

async function fetchSnapshotAggregates(
  window: AppConfig["window"],
  signal: AbortSignal,
): Promise<SnapshotAggregates> {
  const [agents, dashboard] = await Promise.all([
    fetchAgents(window, { signal }),
    fetchDashboard(window, {}, { signal }),
  ]);
  return { window, agents, dashboard };
}

function snapshotAggregatesOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.sessionAggregate(window),
    queryFn: ({ signal }) => fetchSnapshotAggregates(window, signal),
    staleTime: LIVE_AGGREGATE_REFRESH_INTERVAL_MS,
  });
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
  const options = snapshotAggregatesOptions(window);
  const state = queryClient.getQueryState(options.queryKey);
  const needsRefresh =
    forceRefresh ||
    !state ||
    state.data === undefined ||
    state.isInvalidated ||
    Date.now() - state.dataUpdatedAt >= LIVE_AGGREGATE_REFRESH_INTERVAL_MS;
  if (forceRefresh) {
    await queryClient.invalidateQueries({
      queryKey: options.queryKey,
      exact: true,
      refetchType: "none",
    });
  }
  const [aggregates] = await Promise.all([
    queryClient.fetchQuery(options),
    needsRefresh ? invalidateLiveSessionCollections(queryClient) : Promise.resolve(),
  ]);
  return aggregates;
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
  const [loadState, dispatchLoad] = useReducer(
    reduceSessionStoreLoad,
    INITIAL_SESSION_STORE_LOAD_STATE,
  );
  const activeRequestRef = useRef<ActiveLoadRequest | null>(null);
  const liveAggregateWindowRef = useRef<AppConfig["window"] | null>(null);
  const nextRequestIdRef = useRef(1);
  const requestedWindow = loadState.status === "idle" ? null : loadState.window;
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
  const aggregatesQuery = useQuery({
    ...snapshotAggregatesOptions(requestedWindow ?? {}),
    enabled: false,
  });
  const projectsQuery = useQuery({
    ...projectsOptions(requestedWindow ?? {}),
    enabled: requestedWindow !== null,
    placeholderData: keepPreviousData,
  });
  const configFailed = configQuery.isError;
  const refetchConfig = configQuery.refetch;
  const querySnapshot =
    requestedWindow !== null &&
    projectionQuery.data &&
    aggregatesQuery.data &&
    sameWindow(projectionQuery.data.window, requestedWindow) &&
    sameWindow(aggregatesQuery.data.window, requestedWindow)
      ? createSnapshot(requestedWindow, aggregatesQuery.data, projectionQuery.data.sessions)
      : null;

  const reload = useCallback(
    async (window: AppConfig["window"]): Promise<SessionStoreSnapshot | null> => {
      const requestId = nextRequestIdRef.current++;
      activeRequestRef.current = { requestId, window };
      liveAggregateWindowRef.current = null;
      dispatchLoad({ type: "begin", requestId, window });
      try {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: queryKeys.sessionProjections }),
          queryClient.cancelQueries({ queryKey: queryKeys.sessionAggregates }),
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
            queryKey: queryKeys.sessionAggregate(window),
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
          queryClient.fetchQuery(snapshotAggregatesOptions(window)),
          queryClient.fetchQuery(
            sessionProjectionOptions(window, (firstPageProjection) => {
              if (activeRequestRef.current?.requestId !== requestId) return;
              queryClient.setQueryData(queryKeys.sessionProjection(window), firstPageProjection);
            }),
          ),
        ]);
        const snapshot = createSnapshot(window, aggregates, projection.sessions);
        dispatchLoad({ type: "complete", requestId });
        return snapshot;
      } catch (error) {
        if (isCancelledError(error)) return null;
        dispatchLoad({ type: "fail", requestId, error });
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
      const aggregateKey = queryKeys.sessionAggregate(activeWindow);
      const currentProjection = queryClient.getQueryData<SessionProjection>(projectionKey);
      const currentAggregates = queryClient.getQueryData<SnapshotAggregates>(aggregateKey);
      if (!currentProjection || !currentAggregates) {
        const refreshed = await reload(activeWindow);
        await Promise.all([
          invalidateLiveSessionDerivedQueries(queryClient, event),
          invalidateLiveSessionCollections(queryClient),
        ]);
        return refreshed ? { snapshot: refreshed, visibleNewSessions: 0 } : null;
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
      const visibleNewSessions = (event.newSessionRefs ?? []).filter((reference) => {
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
      const liveRefreshRequestId = activeRequest.requestId;
      const forceAggregateRefresh = !sameWindow(liveAggregateWindowRef.current, activeWindow);
      void fetchLiveSnapshotAggregates(queryClient, activeWindow, forceAggregateRefresh)
        .then(() => {
          const latestRequest = activeRequestRef.current;
          if (
            latestRequest?.requestId === liveRefreshRequestId &&
            sameWindow(latestRequest.window, activeWindow)
          ) {
            liveAggregateWindowRef.current = activeWindow;
          }
        })
        .catch(() => undefined);
      return {
        snapshot: createSnapshot(activeWindow, currentAggregates, projection.sessions),
        visibleNewSessions,
      };
    },
    [queryClient, reload],
  );

  const resyncLiveState = useCallback(async (): Promise<SessionStoreSnapshot | null> => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return null;
    const refreshed = await reload(activeRequest.window);
    await invalidateSessionDerivedQueries(queryClient);
    return refreshed;
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
      // reload already recorded the failure in the load state and the retry
      // surface re-renders from it; rethrowing would only leak an
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
    : loadState.status === "failed"
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
        (requestedWindow === null ||
          (loadState.status === "loading" && displayedSnapshot === null))),
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
