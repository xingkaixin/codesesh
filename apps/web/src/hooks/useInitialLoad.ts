import { useEffect, useState } from "react";
import {
  type AgentInfo,
  type AppConfig,
  type ProjectGroup,
  type SessionHead,
  logClientEvent,
} from "../lib/api";

interface InitialLoadDeps {
  refreshAppConfig: () => Promise<AppConfig>;
  refreshAgents: (window: AppConfig["window"]) => Promise<AgentInfo[]>;
  refreshSessions: (window: AppConfig["window"]) => Promise<SessionHead[]>;
  refreshProjects: (window: AppConfig["window"]) => Promise<ProjectGroup[]>;
  resolveWindow: (fallback: AppConfig["window"]) => AppConfig["window"];
}

/**
 * Orchestrates the one-time startup load: config first (for the shared window),
 * then the base data in parallel, holding the single loading/error gate for the
 * whole app.
 */
export function useInitialLoad({
  refreshAppConfig,
  refreshAgents,
  refreshSessions,
  refreshProjects,
  resolveWindow,
}: InitialLoadDeps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const startedAt = performance.now();
    logClientEvent("app.load.start", { path: window.location.pathname });
    (async () => {
      try {
        const config = await refreshAppConfig();
        const window = resolveWindow(config.window);
        const [agentList, sessionList, projectList] = await Promise.all([
          refreshAgents(window),
          refreshSessions(window),
          refreshProjects(window),
        ]);
        logClientEvent("app.load.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          agents: agentList.length,
          sessions: sessionList.length,
          projects: projectList.length,
        });
      } catch (err) {
        console.error("Failed to load data:", err);
        logClientEvent("app.load.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setError("Failed to load data. Is the CLI server running?");
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [refreshAppConfig, refreshAgents, refreshSessions, refreshProjects, resolveWindow]);

  return { loading, error };
}
