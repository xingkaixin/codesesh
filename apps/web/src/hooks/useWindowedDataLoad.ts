import { useEffect, useState } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type FetchOptions,
  type ProjectGroup,
  type SessionHead,
  logClientEvent,
} from "../lib/api";

interface WindowedDataLoadDeps {
  refreshAppConfig: (options?: FetchOptions) => Promise<AppConfig>;
  refreshAgents: (window: AppConfig["window"], options?: FetchOptions) => Promise<AgentInfo[]>;
  refreshSessions: (window: AppConfig["window"], options?: FetchOptions) => Promise<SessionHead[]>;
  refreshProjects: (window: AppConfig["window"], options?: FetchOptions) => Promise<ProjectGroup[]>;
  resolveSelectedWindow: (fallback: AppConfig["window"]) => AppConfig["window"];
}

/**
 * Loads config before the window-filtered collections and cancels the previous
 * load when the selected time window changes.
 */
export function useWindowedDataLoad({
  refreshAppConfig,
  refreshAgents,
  refreshSessions,
  refreshProjects,
  resolveSelectedWindow,
}: WindowedDataLoadDeps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const startedAt = performance.now();
    logClientEvent("app.load.start", { path: window.location.pathname });
    (async () => {
      try {
        const fetchOptions = { signal: ac.signal };
        const config = await refreshAppConfig(fetchOptions);
        const selectedWindow = resolveSelectedWindow(config.window);
        const [agentList, sessionList, projectList] = await Promise.all([
          refreshAgents(selectedWindow, fetchOptions),
          refreshSessions(selectedWindow, fetchOptions),
          refreshProjects(selectedWindow, fetchOptions),
        ]);
        logClientEvent("app.load.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          agents: agentList.length,
          sessions: sessionList.length,
          projects: projectList.length,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        console.error("Failed to load data:", err);
        logClientEvent("app.load.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setError("Failed to load data. Is the CLI server running?");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [refreshAppConfig, refreshAgents, refreshSessions, refreshProjects, resolveSelectedWindow]);

  return { loading, error };
}
