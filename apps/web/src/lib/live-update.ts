/**
 * Live session-update application: merge a SessionsUpdatedEvent into the
 * current session list (apply changes, drop removals, re-sort).
 */
import type { SessionHead, SessionsUpdatedEvent } from "./api";
import { applySessionChanges, compareSessionActivityDesc } from "@codesesh/core/contract";

/**
 * A sessions-updated notice that may lack the incremental diff arrays.
 * The SSE stream always sends the full wire SessionsUpdatedEvent, but a
 * reconnect synthesizes a refresh-everything intent without that diff.
 */
export type LiveSessionsUpdate = Omit<
  SessionsUpdatedEvent,
  "changedSessionHeads" | "removedSessionRefs"
> &
  Partial<Pick<SessionsUpdatedEvent, "changedSessionHeads" | "removedSessionRefs">>;

export { compareSessionActivityDesc };

export function applyLiveSessionUpdate(
  sessions: SessionHead[],
  event: LiveSessionsUpdate,
): SessionHead[] | null {
  if (!event.changedSessionHeads || !event.removedSessionRefs) return null;

  return applySessionChanges(sessions, event.changedSessionHeads, event.removedSessionRefs);
}
