import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  createRegisteredAgents,
  diffSessionSources,
  ensureSessionTagsSync,
  FileSystemSessionSource,
  sessionSignature,
  sortSessions,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
  type SessionHeadChange,
} from "@codesesh/core";
import { appLogger } from "./logging.js";

export type ScanRefreshWorkerMessage =
  | {
      type: "progress";
      requestId: number;
      progress: AgentScanProgress;
    }
  | {
      type: "checkpoint";
      requestId: number;
      checkpoint: ScanRefreshWorkerCheckpoint;
    }
  | {
      type: "done";
      requestId: number;
      changes: SessionHeadChange[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      removedMetaIds: string[];
      durationMs: number;
    }
  | {
      type: "error";
      requestId: number;
      error: string;
      durationMs: number;
    };

export type ScanRefreshWorkerCheckpoint =
  | {
      stage: "scanned";
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
    }
  | {
      stage: "finalizing";
      changes: SessionHeadChange[];
      meta: Record<string, SessionCacheMeta>;
    };

export interface ScanRefreshWorkerRequest {
  type: "run";
  requestId: number;
  agentName: string;
  previousSessions: SessionHead[];
  changedIds: string[] | null;
  sourceSync?: boolean;
  checkpoint?: boolean;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
}

interface CacheMetaDiff {
  changes: Record<string, SessionCacheMeta>;
  removedIds: string[];
}

function computeCacheMetaDiff(
  previous: Record<string, SessionCacheMeta>,
  next: Record<string, SessionCacheMeta>,
): CacheMetaDiff {
  const changes: Record<string, SessionCacheMeta> = {};
  const removedIds: string[] = [];
  for (const [id, meta] of Object.entries(next)) {
    if (!isDeepStrictEqual(previous[id], meta)) changes[id] = meta;
  }
  for (const id of Object.keys(previous)) {
    if (!Object.hasOwn(next, id)) removedIds.push(id);
  }
  return { changes, removedIds };
}

/**
 * Source-level incremental sync. The change decision itself lives in
 * diffSessionSources so this path and FileSystemSessionSource.checkForChanges
 * cannot drift; only the re-parse and merge are local, because the worker holds
 * cached meta received over workerData rather than the agent's live metaMap.
 */
function syncAgentSources(
  agent: FileSystemSessionSource,
  cachedSessions: SessionHead[],
  cachedMeta: Record<string, SessionCacheMeta>,
  windowOptions?: Pick<ScanOptions, "from" | "to">,
  onProgress?: (progress: AgentScanProgress) => void,
): {
  sessions: SessionHead[];
  changedIds: string[];
  sourceCount: number;
  removedCount: number;
  fullRescan: boolean;
} {
  const sessionMap = new Map(cachedSessions.map((session) => [session.id, session]));
  const sourceRefs = agent.listSessionSources(windowOptions);
  const sourceById = new Map(sourceRefs.map((source) => [source.sessionId, source]));
  const { changedIds, removedIds } = diffSessionSources(
    sourceRefs,
    cachedSessions,
    cachedMeta,
    windowOptions,
  );

  if (
    agent.shouldRescanAllSourcesOnChange?.() &&
    (changedIds.length > 0 || removedIds.length > 0)
  ) {
    const scannedSessions = agent.scan({ ...windowOptions, onProgress });
    const enumeratedIds = new Set(sourceRefs.map((source) => source.sessionId));
    const removedIdSet = new Set(removedIds);
    const retainedSessions = cachedSessions.filter(
      (session) => !enumeratedIds.has(session.id) && !removedIdSet.has(session.id),
    );
    return {
      sessions: sortSessions([...retainedSessions, ...scannedSessions]),
      changedIds: [...new Set([...changedIds, ...removedIds])],
      sourceCount: sourceRefs.length,
      removedCount: removedIds.length,
      fullRescan: true,
    };
  }

  for (const sessionId of changedIds) {
    const source = sourceById.get(sessionId);
    if (!source) continue;
    const next = agent.scanSessionSource(source.sourcePath);
    if (next) {
      sessionMap.set(next.id, next);
    } else {
      sessionMap.delete(sessionId);
    }
  }

  for (const sessionId of removedIds) sessionMap.delete(sessionId);

  return {
    sessions: [...sessionMap.values()],
    changedIds: [...new Set([...changedIds, ...removedIds])],
    sourceCount: sourceRefs.length,
    removedCount: removedIds.length,
    fullRescan: false,
  };
}

/**
 * A session still receiving writes will be stale again within seconds, so
 * recomputing its tags every refresh cycle is wasted work — wait for it to
 * settle before paying the getSessionData() parse cost.
 */
const TAG_SETTLE_MS = 60_000;
const TAG_CHECKPOINT_SIZE = 32;

function isSettled(session: SessionHead, now: number): boolean {
  return now - (session.time_updated ?? session.time_created) >= TAG_SETTLE_MS;
}

/**
 * Runs identity resolution (spawns git) and stale smart-tag reclassification
 * on the worker thread, off the server's main event loop.
 */
export function finalizeSessions(
  agent: BaseAgent,
  sessions: SessionHead[],
  onProgress?: (progress: AgentScanProgress) => void,
  onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void,
): SessionHead[] {
  const ordered = sortSessions(attachMissingProjectIdentities(sessions));

  const now = Date.now();
  const settled = ordered.filter((session) => isSettled(session, now));
  if (settled.length === 0) return ordered;

  let lastReportedAt = -Infinity;
  const reportProgress = (processed: number, total: number): void => {
    const now = performance.now();
    if (processed !== 0 && processed !== total && now - lastReportedAt < 100) return;
    lastReportedAt = now;
    onProgress?.({
      phase: "finalizing",
      total,
      processed,
      sessions: ordered.length,
    });
  };
  reportProgress(0, settled.length);

  const sortIndexById = new Map(ordered.map((session, index) => [session.id, index]));
  const taggedById = new Map<string, SessionHead>();
  for (let start = 0; start < settled.length; start += TAG_CHECKPOINT_SIZE) {
    const batch = settled.slice(start, start + TAG_CHECKPOINT_SIZE);
    const taggedBatch = ensureSessionTagsSync(agent, batch, (processed) => {
      reportProgress(start + processed, settled.length);
    }).sessions;
    for (const session of taggedBatch) taggedById.set(session.id, session);

    onCheckpoint?.({
      stage: "finalizing",
      changes: taggedBatch.map((session) => ({
        session,
        sortIndex: sortIndexById.get(session.id) ?? 0,
      })),
      meta: buildAgentCacheMeta(agent, new Set(taggedBatch.map((session) => session.id))),
    });
  }
  return ordered.map((session) => taggedById.get(session.id) ?? session);
}

async function run(data: ScanRefreshWorkerRequest): Promise<void> {
  const startedAt = performance.now();
  const agent = createRegisteredAgents().find((item) => item.name === data.agentName);
  if (!agent) {
    throw new Error(`Unknown agent: ${data.agentName}`);
  }

  appLogger.debug("scan.refresh_worker.started", {
    agent: data.agentName,
    source_sync: data.sourceSync ?? false,
    changed_ids: data.changedIds?.length ?? 0,
    previous_sessions: data.previousSessions.length,
  });

  const reportProgress = (progress: AgentScanProgress): void => {
    parentPort?.postMessage({
      type: "progress",
      requestId: data.requestId,
      progress,
    } satisfies ScanRefreshWorkerMessage);
  };

  agent.setSessionMetaMap(new Map(Object.entries(data.meta)));

  const isAvailable = agent.isAvailable();
  let sessions: SessionHead[];
  let changedIds: string[] | undefined;
  let sourceSyncDetails:
    | {
        sourceCount: number;
        removedCount: number;
        fullRescan: boolean;
      }
    | undefined;

  if (!isAvailable) {
    sessions = [];
  } else if (data.sourceSync && agent instanceof FileSystemSessionSource) {
    const result = syncAgentSources(
      agent,
      data.previousSessions,
      data.meta,
      data.scanOptions,
      reportProgress,
    );
    sessions = result.sessions;
    changedIds = result.changedIds;
    sourceSyncDetails = result;
  } else if (data.changedIds) {
    sessions = await Promise.resolve(agent.incrementalScan(data.previousSessions, data.changedIds));
  } else {
    sessions = await Promise.resolve(
      agent.scan({
        ...data.scanOptions,
        onProgress: reportProgress,
      }),
    );
  }

  sessions = attachMissingProjectIdentities(sessions);
  if (data.checkpoint) {
    const ordered = sortSessions(sessions);
    parentPort?.postMessage({
      type: "checkpoint",
      requestId: data.requestId,
      checkpoint: {
        stage: "scanned",
        sessions: ordered,
        meta: buildAgentCacheMeta(agent, new Set(ordered.map((session) => session.id))),
      },
    } satisfies ScanRefreshWorkerMessage);
    sessions = ordered;
  }

  const scanDuration = performance.now() - startedAt;
  appLogger.debug("scan.refresh_worker.scanned", {
    agent: data.agentName,
    source_sync: data.sourceSync ?? false,
    sessions: sessions.length,
    changed_ids: changedIds?.length ?? 0,
    source_count: sourceSyncDetails?.sourceCount,
    removed_count: sourceSyncDetails?.removedCount,
    full_rescan: sourceSyncDetails?.fullRescan,
    duration_ms: Math.round(scanDuration),
  });

  const finalizeStartedAt = performance.now();
  sessions = finalizeSessions(agent, sessions, reportProgress, (checkpoint) =>
    parentPort?.postMessage({
      type: "checkpoint",
      requestId: data.requestId,
      checkpoint,
    } satisfies ScanRefreshWorkerMessage),
  );
  appLogger.debug("scan.refresh_worker.finalized", {
    agent: data.agentName,
    sessions: sessions.length,
    duration_ms: Math.round(performance.now() - finalizeStartedAt),
    total_duration_ms: Math.round(performance.now() - startedAt),
  });
  const nextMeta = buildAgentCacheMeta(agent, new Set(sessions.map((session) => session.id)));
  const metaDiff = computeCacheMetaDiff(data.meta, nextMeta);
  const diff = computeSessionDiff(
    data.previousSessions,
    sessions,
    [...(changedIds ?? []), ...Object.keys(metaDiff.changes), ...metaDiff.removedIds],
    sessionSignature,
  );

  parentPort?.postMessage({
    type: "done",
    requestId: data.requestId,
    changes: diff.changes,
    removedSessionIds: diff.removedSessionIds,
    meta: metaDiff.changes,
    removedMetaIds: metaDiff.removedIds,
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}

async function handleRequest(data: ScanRefreshWorkerRequest): Promise<void> {
  const startedAt = performance.now();
  try {
    await run(data);
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startedAt,
    } satisfies ScanRefreshWorkerMessage);
  }
}

let requestTail = Promise.resolve();

function enqueueRequest(data: ScanRefreshWorkerRequest): void {
  requestTail = requestTail.then(() => handleRequest(data));
}

const initialRequest = workerData as Partial<ScanRefreshWorkerRequest> | undefined;
if (
  initialRequest?.type === "run" &&
  typeof initialRequest.requestId === "number" &&
  typeof initialRequest.agentName === "string" &&
  Array.isArray(initialRequest.previousSessions)
) {
  enqueueRequest(initialRequest as ScanRefreshWorkerRequest);
}

parentPort?.on("message", (message: ScanRefreshWorkerRequest) => {
  if (message.type === "run") enqueueRequest(message);
});
