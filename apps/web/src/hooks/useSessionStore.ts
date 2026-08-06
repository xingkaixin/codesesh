import { applySessionChanges } from "@codesesh/core/contract";
import { isCancelledError, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
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

type SnapshotAggregates = Pick<SessionStoreSnapshot, "agents" | "projects" | "dashboard">;

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
    fetchDashboard(window, { kind: "global" }, { signal }),
  ]);
  return { agents, projects, dashboard };
}

function snapshotAggregatesOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.sessionSnapshotAggregates(window),
    queryFn: ({ signal }) => fetchSnapshotAggregates(window, signal),
    staleTime: 100,
  });
}

function sessionSnapshotOptions(window: AppConfig["window"]) {
  return queryOptions({
    queryKey: queryKeys.sessionSnapshot(window),
    staleTime: Infinity,
    queryFn: async ({ signal }): Promise<SessionStoreSnapshot> => {
      const [aggregates, sessionResult] = await Promise.all([
        fetchSnapshotAggregates(window, signal),
        fetchSessions({ from: window.from, to: window.to }, { signal }),
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
  const requestedWindowRef = useRef<AppConfig["window"] | null>(null);
  const configQuery = useQuery({
    queryKey: queryKeys.config,
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
  const snapshot = snapshotQuery.data;

  const reload = useCallback(
    async (window: AppConfig["window"]): Promise<SessionStoreSnapshot | null> => {
      requestedWindowRef.current = window;
      setRequestedWindow(window);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.sessionSnapshots });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.sessionSnapshot(window),
          exact: true,
          refetchType: "none",
        });
        return await queryClient.fetchQuery(sessionSnapshotOptions(window));
      } catch (error) {
        if (isCancelledError(error)) return null;
        throw error;
      }
    },
    [queryClient],
  );

  const applyLiveEvent = useCallback(
    async (event: SessionsUpdatedEvent): Promise<SessionStoreSnapshot | null> => {
      const activeWindow = requestedWindowRef.current;
      if (!activeWindow) return null;
      const snapshotKey = queryKeys.sessionSnapshot(activeWindow);
      const current = queryClient.getQueryData<SessionStoreSnapshot>(snapshotKey);
      if (!current) {
        const refreshed = await reload(activeWindow);
        await invalidateLiveSessionDerivedQueries(queryClient, event);
        return refreshed;
      }

      queryClient.setQueryData<SessionStoreSnapshot>(snapshotKey, {
        ...current,
        sessions: applySessionChanges(
          current.sessions,
          event.changedSessionHeads,
          event.removedSessionRefs,
        ),
      });
      await invalidateLiveSessionDerivedQueries(queryClient, event);
      const aggregates = await queryClient.fetchQuery(snapshotAggregatesOptions(activeWindow));
      const updated =
        queryClient.setQueryData<SessionStoreSnapshot>(snapshotKey, (latest) =>
          latest ? { ...latest, ...aggregates } : latest,
        ) ?? null;
      return updated;
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

  const agents = snapshot?.agents ?? EMPTY_SNAPSHOT.agents;
  const agentCatalog = useMemo(() => createAgentCatalog(agents), [agents]);
  const validAgentKeys = useMemo(
    () => new Set(agentCatalog.active.map((agent) => agent.name.toLowerCase())),
    [agentCatalog.active],
  );
  const error = configQuery.error ?? snapshotQuery.error;

  return {
    config: configQuery.data ?? null,
    window: snapshot?.window ?? null,
    agents,
    sessions: snapshot?.sessions ?? EMPTY_SNAPSHOT.sessions,
    projects: snapshot?.projects ?? EMPTY_SNAPSHOT.projects,
    dashboard: snapshot?.dashboard ?? EMPTY_SNAPSHOT.dashboard,
    loading:
      configQuery.isPending ||
      (!configQuery.isError && (requestedWindow === null || snapshotQuery.isPending)),
    error: error ? "Failed to load data. Is the CLI server running?" : null,
    version: snapshotQuery.dataUpdatedAt,
    activeAgents: agentCatalog.active,
    agentCatalog,
    validAgentKeys,
    agentNameMap: agentCatalog.displayNameByKey,
    reload,
    applyLiveEvent,
    resyncLiveState,
  };
}
