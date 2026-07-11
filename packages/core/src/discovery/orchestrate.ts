/**
 * Shared scan-orchestration helpers — pure functions reused by both the CLI
 * one-shot scanner (scanner.ts) and the live file-watch refresher (live-scan.ts).
 *
 * Nothing here touches SQLite, worker threads, or event emission. The two
 * orchestrators keep their own branch strategies (one-shot vs live refresh);
 * these helpers only collapse the duplicated identity / meta / signature / diff
 * plumbing that previously had to be kept in sync by hand.
 */
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { sortSessionsByActivity } from "../contract/session-index.js";
import type { ProjectIdentity, SessionHead } from "../types/index.js";
import type { SessionHeadChange } from "./cache.js";
import { computeIdentity, realFs } from "../projects/index.js";

function createIdentityResolver() {
  const cache = new Map<string, ProjectIdentity>();
  return (directory: string | null | undefined) => {
    const key = directory || "";
    const cached = cache.get(key);
    if (cached) return cached;
    const identity = computeIdentity(directory, realFs);
    cache.set(key, identity);
    return identity;
  };
}

/** Attach a project identity to sessions that don't already have one. */
export function attachMissingProjectIdentities(sessions: SessionHead[]): SessionHead[] {
  const resolveIdentity = createIdentityResolver();
  return sessions.map((session) => {
    if (session.project_identity) return session;
    return { ...session, project_identity: resolveIdentity(session.directory) };
  });
}

/** Serialize an agent's session meta map, optionally restricted to a set of ids. */
export function buildAgentCacheMeta(
  agent: BaseAgent,
  sessionIds?: Set<string>,
): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  const meta: Record<string, SessionCacheMeta> = {};
  if (!metaMap) return meta;

  for (const [id, data] of metaMap.entries()) {
    if (sessionIds && !sessionIds.has(id)) continue;
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }

  return meta;
}

/**
 * Stable signature for the user-visible fields that define a session's identity.
 * Used by both orchestrators to decide whether a session "changed". Includes
 * smart_tags_source_updated_at so that smart-tag reclassification propagates to
 * the persistence diff even when the underlying message stats are unchanged.
 */
export function sessionSignature(session: SessionHead): string {
  return JSON.stringify([
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? session.time_created,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cost,
    session.stats.total_tokens ?? 0,
    session.smart_tags_source_updated_at ?? null,
  ]);
}

/** Sort sessions by activity time, newest first. */
export function sortSessions(sessions: SessionHead[]): SessionHead[] {
  return sortSessionsByActivity(sessions);
}

export interface SessionDiffResult {
  changes: SessionHeadChange[];
  removedSessionIds: string[];
  counts: { new: number; updated: number; removed: number };
}

/**
 * Compute the diff between a cached session set and an updated one.
 *
 * `signature` is injected so callers control the equality口径: a session counts
 * as "changed" if it is new, if its id is in `changedIds`, or if its signature
 * differs from the cached copy. The algorithm is pure — event assembly and
 * no-op short-circuiting stay with the caller.
 */
export function computeSessionDiff(
  cachedSessions: SessionHead[],
  updatedSessions: SessionHead[],
  changedIds: string[] = [],
  signature: (session: SessionHead) => string = sessionSignature,
): SessionDiffResult {
  const cachedMap = new Map(cachedSessions.map((session) => [session.id, session]));
  const updatedIds = new Set(updatedSessions.map((session) => session.id));
  const changedIdSet = new Set(changedIds);
  const changes: SessionHeadChange[] = [];
  const removedSessionIds: string[] = [];
  let newCount = 0;
  let updatedCount = 0;

  updatedSessions.forEach((session, sortIndex) => {
    const cached = cachedMap.get(session.id);
    if (!cached) {
      newCount += 1;
      changes.push({ session, sortIndex });
      return;
    }
    const hasSignatureChange = signature(cached) !== signature(session);
    if (changedIdSet.has(session.id) || hasSignatureChange) {
      updatedCount += 1;
      changes.push({ session, sortIndex });
    }
  });

  for (const session of cachedSessions) {
    if (!updatedIds.has(session.id)) {
      removedSessionIds.push(session.id);
    }
  }

  return {
    changes,
    removedSessionIds,
    counts: { new: newCount, updated: updatedCount, removed: removedSessionIds.length },
  };
}
