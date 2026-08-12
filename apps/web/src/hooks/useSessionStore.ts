import {
  applySessionWindowChanges,
  formatSessionReference,
  getSessionAgentKey,
} from "@codesesh/core/contract";
import {
  isCancelledError,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type DashboardData,
  type ApiProjectGroup,
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

export interface SessionStoreSnapshot {
  window: AppConfig["window"];
  agents: AgentInfo[];
  sessions: SessionHead[];
  projects: ApiProjectGroup[];
  dashboard: DashboardData;
}

export interface LiveSessionApplyResult {
  snapshot: SessionStoreSnapshot;
  visibleNewSessions: number;
}

type SnapshotAggregates = Pick<SessionStoreSnapshot, "agents" | "projects" | "dashboard">;
const LIVE_AGGREGATE_REFRESH_INTERVAL_MS = 2_000;

const EMPTY_SNAPSHOT = {
  agents: [] satisfies AgentInfo[],
  sessions: [] satisfies SessionHead[],
  projects: [] satisfies ApiProjectGroup[],
  dashboard: null,
};

async function loadProjects(
  window: AppConfig["window"],
  signal: AbortSignal,
): Promise<ApiProjectGroup[]> {
  try {
    return (await fetchProjects(window, { signal })).projects;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("Failed to load projects:", error);
    return [];
  }
}

async function fetchSnapshotAggregates(
  window: AppConfig["window"],
  signal: AbortSignal,
): Promise<SnapshotAggregates> {
  const [agents, projects, dashboard] = await Promise.all([
    fetchAgents(window, { signal }),
    loadProjects(window, signal),
    fetchDashboard(window, {}, { signal }),
  ]);
  return { agents, projects, dashboard };
}

function snapshotAggregatesOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.sessionSnapshotAggregates(window),
    queryFn: ({ signal }) => fetchSnapshotAggregates(window, signal),
    staleTime: LIVE_AGGREGATE_REFRESH_INTERVAL_MS,
  });
}

async function fetchLiveSnapshotAggregates(
  queryClient: QueryClient,
  window: AppConfig["window"],
): Promise<SnapshotAggregates> {
  const options = snapshotAggregatesOptions(window);
  const state = queryClient.getQueryState(options.queryKey);
  const needsRefresh =
    !state ||
    state.data === undefined ||
    state.isInvalidated ||
    Date.now() - state.dataUpdatedAt >= LIVE_AGGREGATE_REFRESH_INTERVAL_MS;
  const [aggregates] = await Promise.all([
    queryClient.fetchQuery(options),
    needsRefresh ? invalidateLiveSessionCollections(queryClient) : Promise.resolve(),
  ]);
  return aggregates;
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

function sessionSnapshotOptions(
  window: AppConfig["window"],
  onPreview?: (snapshot: SessionStoreSnapshot) => void,
) {
  return queryOptions({
    queryKey: queryKeys.sessionSnapshot(window),
    staleTime: Infinity,
    queryFn: async ({ signal }): Promise<SessionStoreSnapshot> => {
      let loadedAggregates: SnapshotAggregates | undefined;
      let firstPage: SessionHead[] | undefined;
      const publishPreview = () => {
        if (!loadedAggregates || !firstPage) return;
        onPreview?.({ window, ...loadedAggregates, sessions: firstPage });
      };
      const [aggregates, sessionResult] = await Promise.all([
        fetchSnapshotAggregates(window, signal).then((value) => {
          loadedAggregates = value;
          publishPreview();
          return value;
        }),
        fetchSessions(
          { from: window.from, to: window.to },
          { signal },
          {
            onFirstPage(sessions) {
              firstPage = sessions;
              publishPreview();
            },
          },
        ),
      ]);
      return {
        window,
        ...aggregates,
        sessions: sessionResult.sessions,
      };
    },
  });
}

export function useSessionStore() {
  const queryClient = useQueryClient();
  const [requestedWindow, setRequestedWindow] = useState<AppConfig["window"] | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<SessionStoreSnapshot | null>(null);
  const requestedWindowRef = useRef<AppConfig["window"] | null>(null);
  const reloadVersionRef = useRef(0);
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
  const snapshotQuery = useQuery({
    ...sessionSnapshotOptions(requestedWindow ?? {}),
    enabled: false,
  });
  const configFailed = configQuery.isError;
  const refetchConfig = configQuery.refetch;
  const snapshot = snapshotQuery.data;

  useEffect(() => {
    if (previewSnapshot && sameWindow(snapshot?.window, previewSnapshot.window)) {
      setPreviewSnapshot(null);
    }
  }, [previewSnapshot, snapshot]);

  const reload = useCallback(
    async (window: AppConfig["window"]): Promise<SessionStoreSnapshot | null> => {
      const reloadVersion = reloadVersionRef.current + 1;
      reloadVersionRef.current = reloadVersion;
      requestedWindowRef.current = window;
      setRequestedWindow(window);
      setPreviewSnapshot(null);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.sessionSnapshots });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.sessionSnapshot(window),
          exact: true,
          refetchType: "none",
        });
        return await queryClient.fetchQuery(
          sessionSnapshotOptions(window, (preview) => {
            if (reloadVersionRef.current === reloadVersion) setPreviewSnapshot(preview);
          }),
        );
      } catch (error) {
        if (isCancelledError(error)) return null;
        throw error;
      }
    },
    [queryClient],
  );

  const applyLiveEvent = useCallback(
    async (event: SessionsUpdatedEvent): Promise<LiveSessionApplyResult | null> => {
      const activeWindow = requestedWindowRef.current;
      if (!activeWindow) return null;
      const snapshotKey = queryKeys.sessionSnapshot(activeWindow);
      const current = queryClient.getQueryData<SessionStoreSnapshot>(snapshotKey);
      if (!current) {
        const refreshed = await reload(activeWindow);
        await Promise.all([
          invalidateLiveSessionDerivedQueries(queryClient, event),
          invalidateLiveSessionCollections(queryClient),
        ]);
        return refreshed ? { snapshot: refreshed, visibleNewSessions: 0 } : null;
      }

      const projection = applySessionWindowChanges(current.sessions, {
        changedSessionHeads: event.changedSessionHeads,
        projectionRelatedSessionHeads: event.projectionRelatedSessionHeads,
        projectionSessionOrder: event.projectionSessionOrder,
        removedSessionRefs: event.removedSessionRefs,
        from: activeWindow.from,
        to: activeWindow.to,
      });
      const visibleSessionKeys = new Set(
        projection.sessions.map((session) =>
          formatSessionReference({
            agentName: getSessionAgentKey(session),
            sessionId: session.id,
          }),
        ),
      );
      const previousSessionKeys = new Set(
        current.sessions.map((session) =>
          formatSessionReference({
            agentName: getSessionAgentKey(session),
            sessionId: session.id,
          }),
        ),
      );
      const visibleNewSessions = (event.newSessionRefs ?? []).filter((reference) => {
        const key = formatSessionReference(reference);
        return !previousSessionKeys.has(key) && visibleSessionKeys.has(key);
      }).length;
      console.debug("live.session_projection", {
        window_from: activeWindow.from,
        window_to: activeWindow.to,
        before_sessions: current.sessions.length,
        changed_sessions: event.changedSessionHeads.length,
        projection_related_sessions: event.projectionRelatedSessionHeads?.length ?? 0,
        removed_sessions: event.removedSessionRefs.length,
        after_sessions: projection.sessions.length,
        visible_added_sessions: projection.visibleAddedSessions,
        visible_removed_sessions: projection.visibleRemovedSessions,
        visible_new_sessions: visibleNewSessions,
      });
      queryClient.setQueryData<SessionStoreSnapshot>(snapshotKey, {
        ...current,
        sessions: projection.sessions,
      });
      await invalidateLiveSessionDerivedQueries(queryClient, event);
      const aggregates = await fetchLiveSnapshotAggregates(queryClient, activeWindow);
      const updated =
        queryClient.setQueryData<SessionStoreSnapshot>(snapshotKey, (latest) =>
          latest ? { ...latest, ...aggregates } : latest,
        ) ?? null;
      return updated ? { snapshot: updated, visibleNewSessions } : null;
    },
    [queryClient, reload],
  );

  const resyncLiveState = useCallback(async (): Promise<SessionStoreSnapshot | null> => {
    const activeWindow = requestedWindowRef.current;
    if (!activeWindow) return null;
    const refreshed = await reload(activeWindow);
    await invalidateSessionDerivedQueries(queryClient);
    return refreshed;
  }, [queryClient, reload]);

  const retryLoad = useCallback(async (): Promise<void> => {
    const activeWindow = requestedWindowRef.current;
    if (configFailed || !activeWindow) {
      await refetchConfig();
      return;
    }
    await reload(activeWindow);
  }, [configFailed, refetchConfig, reload]);

  const currentSnapshot = sameWindow(snapshot?.window, requestedWindow) ? snapshot : null;
  const displayedSnapshot =
    currentSnapshot ??
    (sameWindow(previewSnapshot?.window, requestedWindow) ? previewSnapshot : null);
  const agents = displayedSnapshot?.agents ?? EMPTY_SNAPSHOT.agents;
  const agentCatalog = useMemo(() => createAgentCatalog(agents), [agents]);
  const validAgentKeys = useMemo(
    () => new Set(agentCatalog.active.map((agent) => agent.name.toLowerCase())),
    [agentCatalog.active],
  );
  const error = configQuery.isError
    ? "Failed to load configuration. The CLI may be restarting or unavailable."
    : snapshotQuery.isError
      ? "Failed to load session data for the selected time window."
      : null;

  return {
    config: configQuery.data ?? null,
    window: displayedSnapshot?.window ?? null,
    agents,
    sessions: displayedSnapshot?.sessions ?? EMPTY_SNAPSHOT.sessions,
    projects: displayedSnapshot?.projects ?? EMPTY_SNAPSHOT.projects,
    dashboard: displayedSnapshot?.dashboard ?? EMPTY_SNAPSHOT.dashboard,
    loading:
      configQuery.isPending ||
      (!configQuery.isError &&
        (requestedWindow === null || (snapshotQuery.isPending && displayedSnapshot === null))),
    error,
    version: snapshotQuery.dataUpdatedAt,
    activeAgents: agentCatalog.active,
    agentCatalog,
    validAgentKeys,
    agentNameMap: agentCatalog.displayNameByKey,
    reload,
    applyLiveEvent,
    resyncLiveState,
    retryLoad,
  };
}
