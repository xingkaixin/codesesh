import { useCallback, useEffect, useRef, useState } from "react";
import { type SessionData, fetchSessionData, logClientEvent } from "../lib/api";
import type { ViewState } from "../lib/view-state";

interface SessionDetailRequest {
  id: number;
  key: string;
  controller: AbortController;
}

function getSessionKey(viewState: ViewState): string {
  return viewState.mode === "session"
    ? `${viewState.activeAgentKey}/${viewState.activeSessionSlug}`
    : "";
}

/**
 * Owns session-detail state: loads the session for the current "session" route
 * (with a loading flag) and exposes refresh() so data snapshot changes can
 * silently re-fetch the open session without flashing the loading state.
 */
export function useSessionDetail(viewState: ViewState) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const activeRequestRef = useRef<SessionDetailRequest | null>(null);
  const nextRequestIdRef = useRef(1);
  const sessionKey = getSessionKey(viewState);
  const currentSessionKeyRef = useRef(sessionKey);
  currentSessionKeyRef.current = sessionKey;

  const cancelActiveRequest = useCallback((reason: "route-change" | "superseded") => {
    const request = activeRequestRef.current;
    if (!request) return;
    activeRequestRef.current = null;
    request.controller.abort();
    logClientEvent("session.open.cancel", {
      request_id: request.id,
      request_key: request.key,
      reason,
    });
  }, []);

  const loadSession = useCallback(
    async (
      agent: string,
      sessionSlug: string,
      requestKey: string,
      trigger: "route" | "refresh",
    ) => {
      if (currentSessionKeyRef.current !== requestKey) return;
      cancelActiveRequest("superseded");

      const request: SessionDetailRequest = {
        id: nextRequestIdRef.current++,
        key: requestKey,
        controller: new AbortController(),
      };
      activeRequestRef.current = request;
      if (trigger === "route") {
        setSessionLoading(true);
        setSessionError(null);
      }
      const startedAt = performance.now();
      logClientEvent("session.open.start", {
        request_id: request.id,
        request_key: request.key,
        trigger,
        agent,
        session: sessionSlug,
      });

      try {
        const data = await fetchSessionData(agent, sessionSlug, {
          signal: request.controller.signal,
        });
        if (
          activeRequestRef.current?.id !== request.id ||
          currentSessionKeyRef.current !== request.key
        ) {
          logClientEvent("session.open.stale", {
            request_id: request.id,
            request_key: request.key,
          });
          return;
        }
        setSession(data);
        setSessionError(null);
        logClientEvent("session.open.done", {
          request_id: request.id,
          request_key: request.key,
          trigger,
          agent,
          session: sessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          messages: data.messages.length,
        });
      } catch (error) {
        const isCurrent = activeRequestRef.current?.id === request.id;
        if (
          request.controller.signal.aborted ||
          !isCurrent ||
          currentSessionKeyRef.current !== request.key
        ) {
          return;
        }
        logClientEvent("session.open.error", {
          request_id: request.id,
          request_key: request.key,
          trigger,
          agent,
          session: sessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        setSessionError("Session not found");
        setSession(null);
      } finally {
        if (activeRequestRef.current?.id === request.id) {
          activeRequestRef.current = null;
          setSessionLoading(false);
        }
      }
    },
    [cancelActiveRequest],
  );

  useEffect(() => {
    if (viewState.mode !== "session") {
      cancelActiveRequest("route-change");
      setSession(null);
      setSessionError(null);
      setSessionLoading(false);
      return;
    }

    void loadSession(viewState.activeAgentKey, viewState.activeSessionSlug, sessionKey, "route");
    return () => cancelActiveRequest("route-change");
  }, [
    cancelActiveRequest,
    loadSession,
    sessionKey,
    viewState.activeAgentKey,
    viewState.activeSessionSlug,
    viewState.mode,
  ]);

  const refresh = useCallback(async () => {
    if (viewState.mode !== "session") return;
    await loadSession(viewState.activeAgentKey, viewState.activeSessionSlug, sessionKey, "refresh");
  }, [loadSession, sessionKey, viewState]);

  return { session, sessionLoading, sessionError, refresh };
}
