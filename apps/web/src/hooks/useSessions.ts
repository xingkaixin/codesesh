import { useCallback, useState } from "react";
import {
  type AppConfig,
  type SessionHead,
  type SessionsUpdatedEvent,
  fetchSessions,
} from "../lib/api";
import { applyLiveSessionUpdate } from "../lib/live-update";

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

  const applyLiveEvent = useCallback((event: SessionsUpdatedEvent) => {
    setSessions((current) => applyLiveSessionUpdate(current, event) ?? current);
  }, []);

  return { sessions, refresh, applyLiveEvent };
}
