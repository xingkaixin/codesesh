import { getSessionReferenceKey, mergeSessionsUpdatedEvents } from "@codesesh/contract";
import type { QueryClient } from "@tanstack/react-query";
import type { SessionsUpdatedEvent } from "./api";
import { queryKeys } from "./query-keys";

export class PendingSessionProjectionLoads {
  private nextId = 0;
  private readonly events = new Map<number, SessionsUpdatedEvent | null>();

  begin(): number {
    const id = this.nextId++;
    this.events.set(id, null);
    return id;
  }

  record(event: SessionsUpdatedEvent): void {
    for (const [id, current] of this.events) {
      this.events.set(id, current ? mergeSessionsUpdatedEvents(current, event) : event);
    }
  }

  read(id: number): SessionsUpdatedEvent | null {
    return this.events.get(id) ?? null;
  }

  complete(id: number): SessionsUpdatedEvent | null {
    const event = this.read(id);
    this.events.delete(id);
    return event;
  }

  cancel(id: number): void {
    this.events.delete(id);
  }
}

function invalidateSessionCollections(queryClient: QueryClient) {
  return [
    queryClient.invalidateQueries({ queryKey: queryKeys.agentCatalogs }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
    queryClient.invalidateQueries({ queryKey: queryKeys.nodeSessions }),
  ];
}

export async function invalidateLiveSessionCollections(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
    queryClient.invalidateQueries({ queryKey: queryKeys.nodeSessions }),
  ]);
}

export async function invalidateSessionDerivedQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    ...invalidateSessionCollections(queryClient),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionDetails }),
    queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks }),
  ]);
}

export async function invalidateLiveSessionDerivedQueries(
  queryClient: QueryClient,
  event: SessionsUpdatedEvent,
): Promise<void> {
  const changed = new Set([
    ...event.changedSessionHeads.map((item) => getSessionReferenceKey(item.reference)),
    ...event.removedSessionRefs.map(getSessionReferenceKey),
  ]);
  if (changed.size === 0) return;

  await queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (queryKey.length === 1 && queryKey[0] === queryKeys.bookmarks[0]) return true;
      if (
        (queryKey.length !== 3 && queryKey.length !== 4) ||
        queryKey[0] !== queryKeys.sessionDetails[0] ||
        typeof queryKey[1] !== "string" ||
        typeof queryKey[2] !== "string"
      ) {
        return false;
      }
      return changed.has(
        getSessionReferenceKey({
          agentName: queryKey[1],
          sessionId: queryKey[2],
          sourceNodeId: typeof queryKey[3] === "string" ? queryKey[3] : undefined,
        }),
      );
    },
  });
}
