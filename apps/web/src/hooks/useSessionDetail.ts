import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ApiRequestError, fetchSessionData, logClientEvent, type SessionDetail } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import type { ViewState } from "../lib/view-state";

let nextSessionRequestId = 1;

export type SessionDetailError = { kind: "missing" } | { kind: "load-failed"; message: string };

function getSessionDetailError(error: unknown): SessionDetailError {
  if (error instanceof ApiRequestError && error.status === 404) return { kind: "missing" };
  return {
    kind: "load-failed",
    message: error instanceof Error ? error.message : "Unable to load this session.",
  };
}

function mergeSessionDetailUpdate(
  previous: SessionDetail | undefined,
  next: SessionDetail,
): SessionDetail {
  if (next.message_update !== "append" || !previous?.message_cursor) return next;
  return { ...next, messages: [...previous.messages, ...next.messages] };
}

function sessionRoute(viewState: ViewState) {
  if (viewState.mode !== "session") return null;
  return {
    agent: viewState.activeAgentKey,
    sessionId: viewState.activeSessionId,
  };
}

export function useSessionDetail(viewState: ViewState) {
  const queryClient = useQueryClient();
  const route = sessionRoute(viewState);
  const queryKey = queryKeys.sessionDetail(route?.agent ?? "", route?.sessionId ?? "");
  const query = useQuery({
    queryKey,
    enabled: route !== null,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (!route) throw new Error("Session route is required");
      const requestId = nextSessionRequestId++;
      const requestKey = `${route.agent}/${route.sessionId}`;
      const startedAt = performance.now();
      let didLogCancellation = false;
      const logCancellation = () => {
        if (didLogCancellation) return;
        didLogCancellation = true;
        logClientEvent("session.open.cancel", {
          request_id: requestId,
          request_key: requestKey,
          reason: "query-cancelled",
        });
      };
      signal.addEventListener("abort", logCancellation, { once: true });
      logClientEvent("session.open.start", {
        request_id: requestId,
        request_key: requestKey,
        trigger: "route",
        agent: route.agent,
        session: route.sessionId,
      });

      try {
        const previous = queryClient.getQueryData<SessionDetail>(queryKey);
        const response = await fetchSessionData(route.agent, route.sessionId, {
          signal,
          messageCursor: previous?.message_cursor,
        });
        const data = mergeSessionDetailUpdate(previous, response);
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        logClientEvent("session.open.done", {
          request_id: requestId,
          request_key: requestKey,
          trigger: "route",
          agent: route.agent,
          session: route.sessionId,
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
          session: route.sessionId,
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
    sessionError: route !== null && query.isError ? getSessionDetailError(query.error) : null,
    refresh,
  };
}
