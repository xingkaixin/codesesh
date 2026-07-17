import { useEffect } from "react";
import { type AppConfig, logClientEvent } from "../lib/api";
import type { SessionStoreSnapshot } from "./useSessionStore";

interface WindowedDataLoadDeps {
  window: AppConfig["window"] | null;
  reload: (window: AppConfig["window"]) => Promise<SessionStoreSnapshot | null>;
}

export function useWindowedDataLoad({ window, reload }: WindowedDataLoadDeps) {
  useEffect(() => {
    if (!window) return;
    let current = true;
    const startedAt = performance.now();
    logClientEvent("app.load.start", { path: globalThis.window.location.pathname });

    void reload(window)
      .then((snapshot) => {
        if (!current || !snapshot) return;
        logClientEvent("app.load.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          agents: snapshot.agents.length,
          sessions: snapshot.sessions.length,
          projects: snapshot.projects.length,
        });
      })
      .catch((error) => {
        if (!current) return;
        console.error("Failed to load data:", error);
        logClientEvent("app.load.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      current = false;
    };
  }, [reload, window]);
}
