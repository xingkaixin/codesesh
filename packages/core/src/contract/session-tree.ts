import type { SessionHead } from "./session.js";
import { getSessionAgentKey } from "./session-reference.js";

function referenceKey(reference: { agentName: string; sessionId: string }): string {
  return `${reference.agentName.trim().toLowerCase()}\0${reference.sessionId}`;
}

function sessionKey(session: SessionHead): string {
  return `${getSessionAgentKey(session)}\0${session.id}`;
}

function hasActivityInWindow(session: SessionHead, from?: number, to?: number): boolean {
  const activity = session.time_updated ?? session.time_created;
  return (from == null || activity >= from) && (to == null || activity <= to);
}

export function isChildSession(session: SessionHead): boolean {
  return session.parent_reference != null;
}

export function getRootSessions(sessions: SessionHead[]): SessionHead[] {
  return sessions.filter((session) => !session.parent_reference);
}

/**
 * Filters roots by activity and keeps every descendant of a matching root.
 * The input order is preserved so callers keep their existing sort behavior.
 */
export function filterSessionTreeByActivityWindow(
  sessions: SessionHead[],
  from?: number,
  to?: number,
): SessionHead[] {
  if (from == null && to == null) return sessions;

  const available = new Set(sessions.map(sessionKey));
  const childrenByParent = new Map<string, string[]>();

  for (const session of sessions) {
    const parent = session.parent_reference;
    if (!parent || !available.has(referenceKey(parent))) continue;
    const parentKey = referenceKey(parent);
    const children = childrenByParent.get(parentKey);
    if (children) children.push(sessionKey(session));
    else childrenByParent.set(parentKey, [sessionKey(session)]);
  }

  const visible = new Set<string>();
  const pending = getRootSessions(sessions)
    .filter((session) => hasActivityInWindow(session, from, to))
    .map(sessionKey);

  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visible.has(key)) continue;
    visible.add(key);
    for (const childKey of childrenByParent.get(key) ?? []) pending.push(childKey);
  }

  return sessions.filter((session) => visible.has(sessionKey(session)));
}
