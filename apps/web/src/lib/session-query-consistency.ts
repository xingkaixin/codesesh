import type { QueryClient } from "@tanstack/react-query";
import type { SessionsUpdatedEvent } from "./api";
import { queryKeys } from "./query-keys";

function invalidateSessionCollections(queryClient: QueryClient) {
  return [
    queryClient.invalidateQueries({ queryKey: queryKeys.agentCatalogs }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
  ];
}

export async function invalidateLiveSessionCollections(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
  ]);
}

export async function invalidateSessionDerivedQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    ...invalidateSessionCollections(queryClient),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionDetails }),
  ]);
}

export async function invalidateLiveSessionDerivedQueries(
  queryClient: QueryClient,
  event: SessionsUpdatedEvent,
): Promise<void> {
  const changedDetailKeys = new Map<string, readonly unknown[]>();
  for (const item of event.changedSessionHeads) {
    const { agentName, sessionId } = item.reference;
    changedDetailKeys.set(
      `${agentName.toLowerCase()}\0${sessionId}`,
      queryKeys.sessionDetail(agentName.toLowerCase(), sessionId),
    );
  }
  for (const { agentName, sessionId } of event.removedSessionRefs) {
    changedDetailKeys.set(
      `${agentName.toLowerCase()}\0${sessionId}`,
      queryKeys.sessionDetail(agentName.toLowerCase(), sessionId),
    );
  }

  await Promise.all(
    Array.from(changedDetailKeys.values(), (queryKey) =>
      queryClient.invalidateQueries({ queryKey, exact: true }),
    ),
  );
}
