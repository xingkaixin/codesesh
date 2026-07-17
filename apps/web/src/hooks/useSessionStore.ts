import { applySessionChanges } from "@codesesh/core/contract";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type DashboardData,
  type ProjectGroup,
  type SessionHead,
  type SessionsUpdatedEvent,
  fetchAgents,
  fetchConfig,
  fetchDashboard,
  fetchProjects,
  fetchSessions,
} from "../lib/api";

export type LiveSessionsUpdate = Omit<
  SessionsUpdatedEvent,
  "changedSessionHeads" | "removedSessionRefs"
> &
  Partial<Pick<SessionsUpdatedEvent, "changedSessionHeads" | "removedSessionRefs">>;

export interface SessionStoreSnapshot {
  window: AppConfig["window"];
  agents: AgentInfo[];
  sessions: SessionHead[];
  projects: ProjectGroup[];
  dashboard: DashboardData;
}

interface SessionStoreState {
  config: AppConfig | null;
  window: AppConfig["window"] | null;
  agents: AgentInfo[];
  sessions: SessionHead[];
  projects: ProjectGroup[];
  dashboard: DashboardData | null;
  loading: boolean;
  error: string | null;
  version: number;
}

const INITIAL_STATE: SessionStoreState = {
  config: null,
  window: null,
  agents: [],
  sessions: [],
  projects: [],
  dashboard: null,
  loading: true,
  error: null,
  version: 0,
};

function sameWindow(left: AppConfig["window"] | null, right: AppConfig["window"]): boolean {
  return left?.from === right.from && left?.to === right.to && left?.days === right.days;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSessionStore() {
  const [state, dispatch] = useReducer(
    (_current: SessionStoreState, next: SessionStoreState) => next,
    INITIAL_STATE,
  );
  const stateRef = useRef(state);
  const activeRequestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const requestedWindowRef = useRef<AppConfig["window"] | null>(null);

  const updateState = useCallback((update: (current: SessionStoreState) => SessionStoreState) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    dispatch(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchConfig({ signal: controller.signal })
      .then((config) => {
        if (controller.signal.aborted) return;
        updateState((current) => ({ ...current, config }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load config:", error);
        updateState((current) => ({
          ...current,
          loading: false,
          error: "Failed to load data. Is the CLI server running?",
        }));
      });

    return () => controller.abort();
  }, [updateState]);

  useEffect(
    () => () => {
      activeRequestRef.current?.abort();
    },
    [],
  );

  const beginRequest = useCallback(
    (window: AppConfig["window"]) => {
      activeRequestRef.current?.abort();
      const controller = new AbortController();
      const id = ++requestIdRef.current;
      activeRequestRef.current = controller;
      requestedWindowRef.current = window;
      updateState((current) => ({ ...current, loading: true, error: null }));
      return { controller, id };
    },
    [updateState],
  );

  const loadProjects = useCallback(
    async (window: AppConfig["window"], signal: AbortSignal): Promise<ProjectGroup[]> => {
      try {
        return (await fetchProjects(window, { signal })).projects;
      } catch (error) {
        if (signal.aborted) throw error;
        console.error("Failed to load projects:", error);
        return [];
      }
    },
    [],
  );

  const commitSnapshot = useCallback(
    (requestId: number, snapshot: SessionStoreSnapshot): SessionStoreSnapshot | null => {
      if (requestIdRef.current !== requestId) return null;
      activeRequestRef.current = null;
      const committedWindow = { ...snapshot.window };
      const committedSnapshot = { ...snapshot, window: committedWindow };
      updateState((current) => ({
        ...current,
        ...committedSnapshot,
        loading: false,
        error: null,
        version: current.version + 1,
      }));
      return committedSnapshot;
    },
    [updateState],
  );

  const failRequest = useCallback(
    (requestId: number, error: unknown) => {
      if (requestIdRef.current !== requestId || isAbortError(error)) return;
      activeRequestRef.current = null;
      updateState((current) => ({
        ...current,
        loading: false,
        error: "Failed to load data. Is the CLI server running?",
      }));
    },
    [updateState],
  );

  const reload = useCallback(
    async (window: AppConfig["window"]): Promise<SessionStoreSnapshot | null> => {
      const { controller, id } = beginRequest(window);
      try {
        const [agents, sessionResult, projects, dashboard] = await Promise.all([
          fetchAgents(window, { signal: controller.signal }),
          fetchSessions({ from: window.from, to: window.to }, { signal: controller.signal }),
          loadProjects(window, controller.signal),
          fetchDashboard(window),
        ]);
        return commitSnapshot(id, {
          window,
          agents,
          sessions: sessionResult.sessions,
          projects,
          dashboard,
        });
      } catch (error) {
        failRequest(id, error);
        if (controller.signal.aborted || isAbortError(error)) return null;
        throw error;
      }
    },
    [beginRequest, commitSnapshot, failRequest, loadProjects],
  );

  const applyLiveEvent = useCallback(
    async (event: LiveSessionsUpdate): Promise<SessionStoreSnapshot | null> => {
      const window = requestedWindowRef.current;
      if (!window) return null;
      if (
        !event.changedSessionHeads ||
        !event.removedSessionRefs ||
        activeRequestRef.current ||
        !sameWindow(stateRef.current.window, window)
      ) {
        return reload(window);
      }

      const sessions = applySessionChanges(
        stateRef.current.sessions,
        event.changedSessionHeads,
        event.removedSessionRefs,
      );
      const { controller, id } = beginRequest(window);
      try {
        const [agents, projects, dashboard] = await Promise.all([
          fetchAgents(window, { signal: controller.signal }),
          loadProjects(window, controller.signal),
          fetchDashboard(window),
        ]);
        return commitSnapshot(id, { window, agents, sessions, projects, dashboard });
      } catch (error) {
        failRequest(id, error);
        if (controller.signal.aborted || isAbortError(error)) return null;
        throw error;
      }
    },
    [beginRequest, commitSnapshot, failRequest, loadProjects, reload],
  );

  const validAgentKeys = useMemo(
    () => new Set(state.agents.map((agent) => agent.name.toLowerCase())),
    [state.agents],
  );
  const agentNameMap = useMemo(
    () =>
      new Map(state.agents.map((agent) => [agent.name.toLowerCase(), agent.displayName] as const)),
    [state.agents],
  );

  return { ...state, validAgentKeys, agentNameMap, reload, applyLiveEvent };
}
