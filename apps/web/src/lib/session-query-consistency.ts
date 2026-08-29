import { mergeSessionsUpdatedEvents } from "@codesesh/core/contract";
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
  const changedSessionsByAgent = new Map<string, Set<string>>();
  const addChangedSession = (agentName: string, sessionId: string) => {
    const normalizedAgent = agentName.toLowerCase();
    const sessionIds = changedSessionsByAgent.get(normalizedAgent) ?? new Set<string>();
    sessionIds.add(sessionId);
    changedSessionsByAgent.set(normalizedAgent, sessionIds);
  };

  for (const item of event.changedSessionHeads) {
    const { agentName, sessionId } = item.reference;
    addChangedSession(agentName, sessionId);
  }
  for (const { agentName, sessionId } of event.removedSessionRefs) {
    addChangedSession(agentName, sessionId);
  }
  if (changedSessionsByAgent.size === 0) return;

  await queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (
        queryKey.length !== 3 ||
        queryKey[0] !== queryKeys.sessionDetails[0] ||
        typeof queryKey[1] !== "string" ||
        typeof queryKey[2] !== "string"
      ) {
        return false;
      }
      return changedSessionsByAgent.get(queryKey[1])?.has(queryKey[2]) ?? false;
    },
  });
}
