import { isDeepStrictEqual } from "node:util";
import {
  buildSessionPersistenceDiff,
  type PersistedSessionHeadChange,
  type SessionHead,
  type SessionSnapshotCompleteness,
} from "@codesesh/core/runtime/discovery";
import { type SessionCacheMeta } from "@codesesh/core/runtime/agents";

interface ScanRefreshDeltaInput {
  previousSessions: SessionHead[];
  sessions: SessionHead[];
  previousMeta: Record<string, SessionCacheMeta>;
  nextMeta: Record<string, SessionCacheMeta>;
  changedIds?: string[];
  completeness: SessionSnapshotCompleteness;
  explicitRemovedSessionIds: string[];
}

export interface ScanRefreshDelta {
  changes: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  meta: Record<string, SessionCacheMeta>;
  removedMetaIds: string[];
}

export function buildScanRefreshDelta(input: ScanRefreshDeltaInput): ScanRefreshDelta {
  const meta: Record<string, SessionCacheMeta> = {};
  const removedMetaIds: string[] = [];
  for (const [id, value] of Object.entries(input.nextMeta)) {
    if (!isDeepStrictEqual(input.previousMeta[id], value)) meta[id] = value;
  }
  for (const id of Object.keys(input.previousMeta)) {
    if (!Object.hasOwn(input.nextMeta, id)) removedMetaIds.push(id);
  }

  const diff = buildSessionPersistenceDiff(input.previousSessions, input.sessions, {
    candidateChangedIds: [...(input.changedIds ?? []), ...Object.keys(meta), ...removedMetaIds],
    completeness: input.completeness,
    explicitRemovedSessionIds: input.explicitRemovedSessionIds,
  });
  return {
    changes: diff.changedSessions,
    removedSessionIds: diff.removedSessionIds,
    meta,
    removedMetaIds,
  };
}
