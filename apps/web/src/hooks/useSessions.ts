import { useCallback, useState } from "react";
import { type AppConfig, type SessionHead, fetchSessions } from "../lib/api";

/**
 * Owns the session list. Exposes refresh(window) for a full reload and
 * applyLiveEvent for incremental live updates; both are driven by the
 * orchestration hooks.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionHead[]>([]);

  const refresh = useCallback(async (window: AppConfig["window"]) => {
    const result = await fetchSessions({ from: window.from, to: window.to });
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  return { sessions, refresh };
}
