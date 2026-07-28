import type { ReferencedSessionHead, SessionHead } from "./session.js";
import { getProjectAgentKey, getProjectIdentityKey } from "./project-identity.js";
import {
  formatSessionReference,
  getSessionAgentKey,
  type SessionReference,
} from "./session-reference.js";

export type SessionHeadChange = ReferencedSessionHead;

export type SessionHeadRemoval = SessionReference;

export interface CanonicalSessionIndex {
  sourceSessions: SessionHead[];
  sessionsByActivity: SessionHead[];
  byRouteKey: Map<string, SessionHead>;
  byAgent: Map<string, SessionHead[]>;
  byProjectIdentityKey: Map<string, SessionHead[]>;
  byProjectAgentKey: Map<string, SessionHead[]>;
}

export function compareSessionActivityDesc(a: SessionHead, b: SessionHead): number {
  return (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created);
}

export function sortSessionsByActivity(sessions: SessionHead[]): SessionHead[] {
  for (let index = 1; index < sessions.length; index += 1) {
    if (compareSessionActivityDesc(sessions[index - 1]!, sessions[index]!) > 0) {
      return [...sessions].sort(compareSessionActivityDesc);
    }
  }
  return [...sessions];
}

/**
 * Merges shards that are each already sorted by activity, newest first.
 *
 * Callers must uphold that precondition — this does not re-sort. Ties resolve to
 * the earlier shard, which is what a stable `Array.sort` over the concatenation
 * would produce, so the result is element-for-element identical to
 * `sortSessionsByActivity(shards.flat())` at O(n·k) instead of O(n log n).
 */
export function mergeSortedSessions(shards: SessionHead[][]): SessionHead[] {
  const active = shards.filter((shard) => shard.length > 0);
  if (active.length === 0) return [];
  if (active.length === 1) return [...active[0]!];

  const total = active.reduce((sum, shard) => sum + shard.length, 0);
  const merged: SessionHead[] = [];
  const cursors = Array.from({ length: active.length }, () => 0);

  for (let position = 0; position < total; position += 1) {
    let pick = -1;
    for (let shard = 0; shard < active.length; shard += 1) {
      const cursor = cursors[shard]!;
      if (cursor >= active[shard]!.length) continue;
      if (
        pick === -1 ||
        compareSessionActivityDesc(active[shard]![cursor]!, active[pick]![cursors[pick]!]!) < 0
      ) {
        pick = shard;
      }
    }
    merged.push(active[pick]![cursors[pick]!]!);
    cursors[pick]! += 1;
  }

  return merged;
}

export function getSessionRouteKey(agentName: string, sessionId: string): string {
  return formatSessionReference({ agentName, sessionId });
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const current = map.get(key);
  if (current) {
    current.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function createSessionIndex(sourceSessions: SessionHead[]): CanonicalSessionIndex {
  const byRouteKey = new Map<string, SessionHead>();
  const byAgent = new Map<string, SessionHead[]>();
  const byProjectIdentityKey = new Map<string, SessionHead[]>();
  const byProjectAgentKey = new Map<string, SessionHead[]>();

  for (const session of sourceSessions) {
    const agentName = getSessionAgentKey(session);
    const routeKey = getSessionRouteKey(agentName, session.id);
    if (!byRouteKey.has(routeKey)) byRouteKey.set(routeKey, session);
  }

  const sessionsByActivity = sortSessionsByActivity(sourceSessions);
  for (const session of sessionsByActivity) {
    const agentName = getSessionAgentKey(session);
    pushMapValue(byAgent, agentName, session);

    const identity = session.project_identity;
    if (!identity?.key) continue;

    const projectIdentityKey = getProjectIdentityKey(identity);
    pushMapValue(byProjectIdentityKey, projectIdentityKey, session);
    pushMapValue(byProjectAgentKey, getProjectAgentKey(projectIdentityKey, agentName), session);
  }

  return {
    sourceSessions,
    sessionsByActivity,
    byRouteKey,
    byAgent,
    byProjectIdentityKey,
    byProjectAgentKey,
  };
}

export function applySessionChanges(
  sessions: SessionHead[],
  changes: SessionHeadChange[],
  removals: SessionHeadRemoval[],
): SessionHead[] {
  const byRouteKey = new Map<string, SessionHead>();
  for (const session of sessions) {
    byRouteKey.set(getSessionRouteKey(getSessionAgentKey(session), session.id), session);
  }

  for (const removal of removals) {
    byRouteKey.delete(getSessionRouteKey(removal.agentName, removal.sessionId));
  }
  for (const change of changes) {
    byRouteKey.set(
      getSessionRouteKey(change.reference.agentName, change.reference.sessionId),
      change.session,
    );
  }

  return sortSessionsByActivity([...byRouteKey.values()]);
}

export function updateSessionIndex(
  index: CanonicalSessionIndex,
  changes: SessionHeadChange[],
  removals: SessionHeadRemoval[],
): CanonicalSessionIndex {
  return createSessionIndex(applySessionChanges(index.sourceSessions, changes, removals));
}
