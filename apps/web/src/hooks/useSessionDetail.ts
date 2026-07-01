import { useCallback, useEffect, useState } from "react";
import { type SessionData, fetchSessionData, logClientEvent } from "../lib/api";
import type { ViewState } from "../lib/view-state";

/**
 * Owns session-detail state: loads the session for the current "session" route
 * (with a loading flag) and exposes refresh() for the live-update subscription
 * to silently re-fetch the open session without flashing the loading state.
 */
export function useSessionDetail(viewState: ViewState) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const sessionKey =
    viewState.mode === "session"
      ? `${viewState.activeAgentKey}/${viewState.activeSessionSlug}`
      : "";

  useEffect(() => {
    if (viewState.mode !== "session") {
      setSession(null);
      setSessionError(null);
      return;
    }
    const ac = new AbortController();
    setSessionLoading(true);
    setSessionError(null);
    const startedAt = performance.now();
    logClientEvent("session.open.start", {
      agent: viewState.activeAgentKey,
      session: viewState.activeSessionSlug,
    });
    (async () => {
      try {
        const data = await fetchSessionData(viewState.activeAgentKey, viewState.activeSessionSlug);
        setSession(data);
        logClientEvent("session.open.done", {
          agent: viewState.activeAgentKey,
          session: viewState.activeSessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          messages: data.messages.length,
        });
      } catch (err) {
        logClientEvent("session.open.error", {
          agent: viewState.activeAgentKey,
          session: viewState.activeSessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setSessionError("Session not found");
        setSession(null);
      } finally {
        setSessionLoading(false);
      }
    })();
    return () => ac.abort();
  }, [sessionKey, viewState.activeAgentKey, viewState.activeSessionSlug, viewState.mode]);

  const refresh = useCallback(async () => {
    if (viewState.mode !== "session") return;
    try {
      const data = await fetchSessionData(viewState.activeAgentKey, viewState.activeSessionSlug);
      setSession(data);
      setSessionError(null);
    } catch {
      setSession(null);
      setSessionError("Session not found");
    }
  }, [viewState]);

  return { session, sessionLoading, sessionError, refresh };
}
