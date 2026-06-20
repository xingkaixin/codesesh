/**
 * Live session-update application: merge a SessionsUpdatedEvent into the
 * current session list (apply changes, drop removals, re-sort).
 */
import type { SessionHead, SessionsUpdatedEvent } from "./api";
import { getSessionAgentKey } from "./session-indexes";
import { getSessionRouteKey } from "./session-indexes";

export function compareSessionActivityDesc(a: SessionHead, b: SessionHead): number {
  return (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created);
}

export function applyLiveSessionUpdate(
  sessions: SessionHead[],
  event: SessionsUpdatedEvent,
): SessionHead[] | null {
  if (!event.changedSessionHeads || !event.removedSessionRefs) return null;

  const byKey = new Map(
    sessions.map((sessionItem) => [
      getSessionRouteKey(getSessionAgentKey(sessionItem), sessionItem.id),
      sessionItem,
    ]),
  );

  for (const { agentName, sessionId } of event.removedSessionRefs) {
    byKey.delete(getSessionRouteKey(agentName, sessionId));
  }

  for (const { agentName, session: sessionItem } of event.changedSessionHeads) {
    byKey.set(getSessionRouteKey(agentName, sessionItem.id), sessionItem);
  }

  return [...byKey.values()].sort(compareSessionActivityDesc);
}
