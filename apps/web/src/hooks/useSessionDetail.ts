import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchSessionData, logClientEvent } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import type { ViewState } from "../lib/view-state";

let nextSessionRequestId = 1;

function sessionRoute(viewState: ViewState) {
  if (viewState.mode !== "session") return null;
  return {
    agent: viewState.activeAgentKey,
    sessionSlug: viewState.activeSessionSlug,
  };
}

export function useSessionDetail(viewState: ViewState) {
  const route = sessionRoute(viewState);
  const query = useQuery({
    queryKey: queryKeys.sessionDetail(route?.agent ?? "", route?.sessionSlug ?? ""),
    enabled: route !== null,
    queryFn: async ({ signal }) => {
      if (!route) throw new Error("Session route is required");
      const requestId = nextSessionRequestId++;
      const requestKey = `${route.agent}/${route.sessionSlug}`;
      const startedAt = performance.now();
      let didLogCancellation = false;
      const logCancellation = () => {
        if (didLogCancellation) return;
        didLogCancellation = true;
        logClientEvent("session.open.cancel", {
          request_id: requestId,
          request_key: requestKey,
          reason: "route-change",
        });
      };
      signal.addEventListener("abort", logCancellation, { once: true });
      logClientEvent("session.open.start", {
        request_id: requestId,
        request_key: requestKey,
        trigger: "route",
        agent: route.agent,
        session: route.sessionSlug,
      });

      try {
        const data = await fetchSessionData(route.agent, route.sessionSlug, { signal });
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        logClientEvent("session.open.done", {
          request_id: requestId,
          request_key: requestKey,
          trigger: "route",
          agent: route.agent,
          session: route.sessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          messages: data.messages.length,
        });
        return data;
      } catch (error) {
        if (signal.aborted) {
          logCancellation();
          throw error;
        }
        logClientEvent("session.open.error", {
          request_id: requestId,
          request_key: requestKey,
          trigger: "route",
          agent: route.agent,
          session: route.sessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        signal.removeEventListener("abort", logCancellation);
      }
    },
  });

  const refresh = useCallback(async () => {
    if (!route) return;
    await query.refetch({ cancelRefetch: true });
  }, [query, route]);

  return {
    session: route ? (query.data ?? null) : null,
    sessionLoading: route !== null && query.isPending,
    sessionError: route !== null && query.isError ? "Session not found" : null,
    refresh,
  };
}
