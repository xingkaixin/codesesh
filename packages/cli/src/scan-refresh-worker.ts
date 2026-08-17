import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  createRegisteredAgents,
  ensureSessionTagsSync,
  FileSystemSessionSource,
  sessionSignature,
  SMART_TAG_CLASSIFIER_REVISION,
  sortSessions,
  synchronizePricingGeneration,
  synchronizeSessionSources,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
  type PersistedSessionHeadChange,
  type SessionSourceFailure,
  type SessionSnapshotCompleteness,
  type SessionTagTiming,
} from "@codesesh/core";
import { appLogger } from "./logging.js";
import { MonotonicValueSampler } from "./monotonic-value-sampler.js";
import {
  AgentUnavailableDuringScanError,
  type ScanRefreshWorkerErrorCode,
} from "./scan-refresh-error.js";
import {
  isBackfillOperation,
  synchronizesSessionSources,
  usesDurableCheckpoints,
  type ScanRefreshOperation,
} from "./scan-refresh-operation.js";

export type ScanRefreshWorkerMessage =
  | {
      type: "progress";
      requestId: number;
      generation: number;
      progress: AgentScanProgress;
    }
  | {
      type: "checkpoint";
      requestId: number;
      generation: number;
      checkpoint: ScanRefreshWorkerCheckpoint;
    }
  | {
      type: "done";
      requestId: number;
      generation: number;
      changes: PersistedSessionHeadChange[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      removedMetaIds: string[];
      sourceFailures: SessionSourceFailure[];
      completeness: SessionSnapshotCompleteness;
      explicitRemovedSessionIds: string[];
      durationMs: number;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      error: string;
      errorCode?: ScanRefreshWorkerErrorCode;
      durationMs: number;
    };

export type ScanRefreshWorkerCheckpoint =
  | {
      stage: "scanned";
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      completeness: SessionSnapshotCompleteness;
    }
  | {
      stage: "finalizing";
      changes: PersistedSessionHeadChange[];
      meta: Record<string, SessionCacheMeta>;
      backfillCursor?: string;
    };

export interface ScanRefreshWorkerRunRequest {
  type: "run";
  requestId: number;
  agentName: string;
  generation: number;
  pricingGenerationId: number;
  previousSessions?: SessionHead[];
  operation: ScanRefreshOperation;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta?: Record<string, SessionCacheMeta>;
}

export interface ScanRefreshWorkerCommitRequest {
  type: "commit";
  requestId: number;
  generation: number;
}

export type ScanRefreshWorkerRequest = ScanRefreshWorkerRunRequest | ScanRefreshWorkerCommitRequest;

interface StagedWorkerBaseline {
  requestId: number;
  generation: number;
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
}

interface WorkerBaseline {
  agentName: string;
  agent: BaseAgent;
  generation: number;
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  staged: StagedWorkerBaseline | null;
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

function hasStaleSmartTags(session: SessionHead): boolean {
  const sourceUpdatedAt = session.time_updated ?? session.time_created;
  return (
    !Array.isArray(session.smart_tags) ||
    session.smart_tags_source_updated_at !== sourceUpdatedAt ||
    session.smart_tags_classifier_revision !== SMART_TAG_CLASSIFIER_REVISION
  );
}

interface BackfillSelection {
  orderedSessions: SessionHead[];
  finalizeSessionIds: ReadonlySet<string>;
  cursorIndex: number;
}

function selectBackfillSessions(
  sessions: SessionHead[],
  changedIds: string[],
  cursor: string | null | undefined,
): BackfillSelection {
  const orderedSessions = sortSessions(sessions);
  const cursorIndex = cursor
    ? orderedSessions.findIndex((session) => session.reference.sessionId === cursor)
    : -1;
  const finalizeSessionIds = new Set<string>();
  const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;

  for (let index = startIndex; index < orderedSessions.length; index += 1) {
    finalizeSessionIds.add(orderedSessions[index]!.reference.sessionId);
  }

  for (const changedId of changedIds) finalizeSessionIds.add(changedId);

  // A hot session before the cursor remains stale until it settles. Keep it in
  // the next pass so it is not permanently skipped when it becomes idle.
  for (let index = 0; index <= cursorIndex; index += 1) {
    const session = orderedSessions[index]!;
    if (hasStaleSmartTags(session)) finalizeSessionIds.add(session.reference.sessionId);
  }

  return { orderedSessions, finalizeSessionIds, cursorIndex };
}

/**
 * scan() rebuilds heads from the source without smart tags, which would force
 * a full reclassification pass (one getSessionData() per session). Carry the
 * previous tags over and let the staleness check in ensureSessionTagsSync —
 * smart_tags_source_updated_at vs time_updated — decide what to recompute.
 */
function inheritSmartTags(sessions: SessionHead[], previousSessions: SessionHead[]): SessionHead[] {
  const previousById = new Map(
    previousSessions.map((session) => [session.reference.sessionId, session]),
  );
  return sessions.map((session) => {
    if (Array.isArray(session.smart_tags)) return session;
    const previous = previousById.get(session.reference.sessionId);
    if (!previous || !Array.isArray(previous.smart_tags)) return session;
    return {
      ...session,
      smart_tags: previous.smart_tags,
      smart_tags_source_updated_at: previous.smart_tags_source_updated_at,
      smart_tags_classifier_revision: previous.smart_tags_classifier_revision,
    };
  });
}

/**
 * A session still receiving writes will be stale again within seconds, so
 * recomputing its tags every refresh cycle is wasted work — wait for it to
 * settle before paying the getSessionData() parse cost.
 */
const TAG_SETTLE_MS = 60_000;
const TAG_CHECKPOINT_SIZE = 32;
const PROGRESS_INTERVAL_MS = 100;

interface SessionFinalizationTiming extends SessionTagTiming {
  batches: number;
}

function createSessionFinalizationTiming(): SessionFinalizationTiming {
  return {
    batches: 0,
    sessions: 0,
    cacheHits: 0,
    staleSessions: 0,
    failedSessions: 0,
    getSessionDataCalls: 0,
    getSessionDataMs: 0,
    classifySessionTagsCalls: 0,
    classifySessionTagsMs: 0,
  };
}

function addSessionTagTiming(target: SessionFinalizationTiming, source: SessionTagTiming): void {
  target.sessions += source.sessions;
  target.cacheHits += source.cacheHits;
  target.staleSessions += source.staleSessions;
  target.failedSessions += source.failedSessions;
  target.getSessionDataCalls += source.getSessionDataCalls;
  target.getSessionDataMs += source.getSessionDataMs;
  target.classifySessionTagsCalls += source.classifySessionTagsCalls;
  target.classifySessionTagsMs += source.classifySessionTagsMs;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

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
  finalizeSessionIds?: ReadonlySet<string>,
  onTiming?: (timing: SessionTagTiming) => void,
): SessionHead[] {
  const ordered = sortSessions(attachMissingProjectIdentities(sessions));

  const now = Date.now();
  const settled = ordered.filter(
    (session) =>
      (!finalizeSessionIds || finalizeSessionIds.has(session.reference.sessionId)) &&
      isSettled(session, now),
  );
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

  const sortIndexById = new Map(
    ordered.map((session, index) => [session.reference.sessionId, index]),
  );
  const taggedById = new Map<string, SessionHead>();
  for (let start = 0; start < settled.length; start += TAG_CHECKPOINT_SIZE) {
    const batch = settled.slice(start, start + TAG_CHECKPOINT_SIZE);
    const taggedResult = ensureSessionTagsSync(agent, batch, (processed) => {
      reportProgress(start + processed, settled.length);
    });
    if (taggedResult.timing) onTiming?.(taggedResult.timing);
    const taggedBatch = taggedResult.sessions;
    for (const session of taggedBatch) taggedById.set(session.reference.sessionId, session);

    onCheckpoint?.({
      stage: "finalizing",
      changes: taggedBatch.map((session) => ({
        session,
        sortIndex: sortIndexById.get(session.reference.sessionId) ?? 0,
      })),
      meta: buildAgentCacheMeta(
        agent,
        new Set(taggedBatch.map((session) => session.reference.sessionId)),
      ),
    });
  }
  return ordered.map((session) => taggedById.get(session.reference.sessionId) ?? session);
}

let workerBaseline: WorkerBaseline | null = null;

function baselineFor(data: ScanRefreshWorkerRunRequest): WorkerBaseline {
  const generation = data.generation ?? 0;
  const hasSessions = Array.isArray(data.previousSessions);
  const hasMeta = data.meta != null;
  if (hasSessions !== hasMeta)
    throw new Error("Worker baseline requires sessions and meta together");

  if (hasSessions && hasMeta) {
    if (workerBaseline) throw new Error("Scan refresh worker baseline is already initialized");
    const agent = createRegisteredAgents().find((item) => item.name === data.agentName);
    if (!agent) throw new Error(`Unknown agent: ${data.agentName}`);
    workerBaseline = {
      agentName: data.agentName,
      agent,
      generation,
      sessions: data.previousSessions!,
      meta: data.meta!,
      staged: null,
    };
  }

  if (!workerBaseline) throw new Error("Scan refresh worker baseline is not initialized");
  if (workerBaseline.agentName !== data.agentName) {
    throw new Error(`Worker Agent mismatch: expected ${workerBaseline.agentName}`);
  }
  if (workerBaseline.generation !== generation) {
    throw new Error(
      `Worker generation mismatch: expected ${workerBaseline.generation}, received ${generation}`,
    );
  }
  if (workerBaseline.staged) {
    throw new Error(`Worker result ${workerBaseline.staged.requestId} is awaiting commit`);
  }

  workerBaseline.agent.setSessionMetaMap(new Map(Object.entries(workerBaseline.meta)));
  return workerBaseline;
}

async function run(
  data: ScanRefreshWorkerRunRequest,
  progressEmitter: MonotonicValueSampler<AgentScanProgress>,
): Promise<void> {
  const startedAt = performance.now();
  const baseline = baselineFor(data);
  const { agent } = baseline;
  const previousSessions = baseline.sessions;
  const previousMeta = baseline.meta;
  const operation = data.operation;
  const sourceSynchronization = synchronizesSessionSources(operation);
  const backfill = isBackfillOperation(operation);
  const durableCheckpoints = usesDurableCheckpoints(operation);
  const backfillCursor = backfill ? operation.cursor : undefined;

  appLogger.debug("scan.refresh_worker.started", {
    agent: data.agentName,
    operation: operation.kind,
    backfill_cursor: backfillCursor ?? undefined,
    changed_ids: operation.kind === "incremental-scan" ? operation.changedIds.length : 0,
    previous_sessions: previousSessions.length,
  });

  const reportProgress = (progress: AgentScanProgress): void => {
    progressEmitter.push(progress, progress.phase ?? "scanning");
  };

  if (!agent.isAvailable()) {
    appLogger.warn("scan.refresh_worker.agent_unavailable", {
      agent: data.agentName,
      operation: operation.kind,
    });
    throw new AgentUnavailableDuringScanError(data.agentName);
  }

  let sessions: SessionHead[];
  let changedIds: string[] | undefined;
  let sourceFailures: SessionSourceFailure[] = [];
  let explicitRemovedSessionIds: string[] = [];
  let finalizeSessionIds: ReadonlySet<string> | undefined;
  let backfillOrder: SessionHead[] | undefined;
  let backfillCursorIndex = -1;
  let sourceSynchronizationDetails:
    | {
        sourceCount: number;
        removedCount: number;
      }
    | undefined;

  if (operation.kind === "recompute-derived") {
    sessions = previousSessions;
  } else if (sourceSynchronization) {
    if (!(agent instanceof FileSystemSessionSource)) {
      throw new Error(`Agent ${agent.name} does not support Session Source synchronization`);
    }
    const result = synchronizeSessionSources(
      agent,
      { sessions: previousSessions, meta: previousMeta },
      {
        kind: "refresh",
        scanOptions: { ...data.scanOptions, onProgress: reportProgress },
      },
    );
    sessions = result.sessions;
    changedIds = result.changedSessionIds;
    finalizeSessionIds = new Set(result.finalizeSessionIds);
    sourceSynchronizationDetails = {
      sourceCount: result.sourceCount,
      removedCount: result.removedSourceCount,
    };
    sourceFailures = result.sourceFailures;
    explicitRemovedSessionIds = result.explicitRemovedSessionIds;
  } else if (operation.kind === "incremental-scan") {
    changedIds = operation.changedIds;
    sessions = inheritSmartTags(
      await Promise.resolve(
        agent.incrementalScan(previousSessions, operation.changedIds, undefined, {
          ...data.scanOptions,
          onProgress: reportProgress,
        }),
      ),
      previousSessions,
    );
  } else if (agent instanceof FileSystemSessionSource) {
    const result = synchronizeSessionSources(
      agent,
      { sessions: previousSessions, meta: previousMeta },
      {
        kind: "reload",
        scanOptions: { ...data.scanOptions, onProgress: reportProgress },
      },
    );
    sessions = result.sessions;
    finalizeSessionIds = new Set(result.finalizeSessionIds);
    sourceFailures = result.sourceFailures;
    explicitRemovedSessionIds = result.explicitRemovedSessionIds;
  } else {
    sessions = inheritSmartTags(
      await Promise.resolve(
        agent.scan({
          ...data.scanOptions,
          onProgress: reportProgress,
        }),
      ),
      previousSessions,
    );
  }

  sessions = attachMissingProjectIdentities(sessions);
  const completeness: SessionSnapshotCompleteness =
    data.scanOptions.from == null && data.scanOptions.to == null && sourceFailures.length === 0
      ? "complete"
      : "partial";
  if (durableCheckpoints) {
    const ordered = sortSessions(sessions);
    parentPort?.postMessage({
      type: "checkpoint",
      requestId: data.requestId,
      generation: baseline.generation,
      checkpoint: {
        stage: "scanned",
        sessions: ordered,
        meta: buildAgentCacheMeta(
          agent,
          new Set(ordered.map((session) => session.reference.sessionId)),
        ),
        completeness,
      },
    } satisfies ScanRefreshWorkerMessage);
    sessions = ordered;
  }

  if (backfill) {
    const selection = selectBackfillSessions(sessions, changedIds ?? [], backfillCursor);
    sessions = selection.orderedSessions;
    finalizeSessionIds = selection.finalizeSessionIds;
    backfillOrder = selection.orderedSessions;
    backfillCursorIndex = selection.cursorIndex;
  }

  const scanDuration = performance.now() - startedAt;
  appLogger.debug("scan.refresh_worker.scanned", {
    agent: data.agentName,
    operation: operation.kind,
    backfill_cursor: backfillCursor ?? undefined,
    sessions: sessions.length,
    changed_ids: changedIds?.length ?? 0,
    source_count: sourceSynchronizationDetails?.sourceCount,
    removed_count: sourceSynchronizationDetails?.removedCount,
    failed_sources: sourceFailures.length,
    duration_ms: Math.round(scanDuration),
  });

  const finalizeStartedAt = performance.now();
  const finalizationTiming = createSessionFinalizationTiming();
  const backfillPositionById = backfillOrder
    ? new Map(backfillOrder.map((session, index) => [session.reference.sessionId, index]))
    : undefined;
  sessions = finalizeSessions(
    agent,
    sessions,
    reportProgress,
    durableCheckpoints
      ? (checkpoint) => {
          let nextCheckpoint = checkpoint;
          if (checkpoint.stage === "finalizing" && backfillOrder && backfillPositionById) {
            let nextCursorIndex = backfillCursorIndex;
            for (const { session } of checkpoint.changes) {
              const index = backfillPositionById.get(session.reference.sessionId);
              if (index != null && index > nextCursorIndex) nextCursorIndex = index;
            }
            if (nextCursorIndex > backfillCursorIndex) {
              backfillCursorIndex = nextCursorIndex;
              nextCheckpoint = {
                ...checkpoint,
                backfillCursor: backfillOrder[nextCursorIndex]?.reference.sessionId,
              };
            }
          }
          parentPort?.postMessage({
            type: "checkpoint",
            requestId: data.requestId,
            generation: baseline.generation,
            checkpoint: nextCheckpoint,
          } satisfies ScanRefreshWorkerMessage);
        }
      : undefined,
    finalizeSessionIds,
    (batchTiming) => {
      finalizationTiming.batches += 1;
      addSessionTagTiming(finalizationTiming, batchTiming);
      appLogger.debug("scan.refresh_worker.finalization_batch", {
        agent: data.agentName,
        batch: finalizationTiming.batches,
        sessions: batchTiming.sessions,
        cache_hits: batchTiming.cacheHits,
        stale_sessions: batchTiming.staleSessions,
        failed_sessions: batchTiming.failedSessions,
        get_session_data_calls: batchTiming.getSessionDataCalls,
        get_session_data_ms: roundMilliseconds(batchTiming.getSessionDataMs),
        classify_session_tags_calls: batchTiming.classifySessionTagsCalls,
        classify_session_tags_ms: roundMilliseconds(batchTiming.classifySessionTagsMs),
      });
    },
  );
  const finalizationDuration = performance.now() - finalizeStartedAt;
  const otherFinalizationMs = Math.max(
    0,
    finalizationDuration -
      finalizationTiming.getSessionDataMs -
      finalizationTiming.classifySessionTagsMs,
  );
  appLogger.debug("scan.refresh_worker.finalized", {
    agent: data.agentName,
    operation: operation.kind,
    backfill_cursor: backfillOrder?.[backfillCursorIndex]?.reference.sessionId,
    sessions: sessions.length,
    finalized_sessions: finalizationTiming.sessions,
    batches: finalizationTiming.batches,
    cache_hits: finalizationTiming.cacheHits,
    stale_sessions: finalizationTiming.staleSessions,
    failed_sessions: finalizationTiming.failedSessions,
    get_session_data_calls: finalizationTiming.getSessionDataCalls,
    get_session_data_ms: roundMilliseconds(finalizationTiming.getSessionDataMs),
    get_session_data_avg_ms: roundMilliseconds(
      finalizationTiming.getSessionDataCalls > 0
        ? finalizationTiming.getSessionDataMs / finalizationTiming.getSessionDataCalls
        : 0,
    ),
    classify_session_tags_calls: finalizationTiming.classifySessionTagsCalls,
    classify_session_tags_ms: roundMilliseconds(finalizationTiming.classifySessionTagsMs),
    classify_session_tags_avg_ms: roundMilliseconds(
      finalizationTiming.classifySessionTagsCalls > 0
        ? finalizationTiming.classifySessionTagsMs / finalizationTiming.classifySessionTagsCalls
        : 0,
    ),
    other_finalization_ms: roundMilliseconds(otherFinalizationMs),
    duration_ms: roundMilliseconds(finalizationDuration),
    total_duration_ms: Math.round(performance.now() - startedAt),
  });
  const nextMeta = buildAgentCacheMeta(
    agent,
    new Set(sessions.map((session) => session.reference.sessionId)),
  );
  const metaDiff = computeCacheMetaDiff(previousMeta, nextMeta);
  const diff = computeSessionDiff(
    previousSessions,
    sessions,
    [...(changedIds ?? []), ...Object.keys(metaDiff.changes), ...metaDiff.removedIds],
    sessionSignature,
  );

  baseline.staged = {
    requestId: data.requestId,
    generation: baseline.generation,
    sessions,
    meta: nextMeta,
  };
  progressEmitter.flush();
  parentPort?.postMessage({
    type: "done",
    requestId: data.requestId,
    generation: baseline.generation,
    changes: diff.changes,
    removedSessionIds: diff.removedSessionIds,
    meta: metaDiff.changes,
    removedMetaIds: metaDiff.removedIds,
    sourceFailures,
    completeness,
    explicitRemovedSessionIds,
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}

async function handleRequest(data: ScanRefreshWorkerRunRequest): Promise<void> {
  const startedAt = performance.now();
  const progressEmitter = new MonotonicValueSampler<AgentScanProgress>(
    PROGRESS_INTERVAL_MS,
    (progress) => {
      parentPort?.postMessage({
        type: "progress",
        requestId: data.requestId,
        generation: data.generation ?? 0,
        progress,
      } satisfies ScanRefreshWorkerMessage);
    },
  );
  try {
    synchronizePricingGeneration(data.pricingGenerationId);
    await run(data, progressEmitter);
  } catch (error) {
    progressEmitter.flush();
    postRequestError(data, error, startedAt);
  } finally {
    progressEmitter.cancel();
  }
}

let requestTail = Promise.resolve();

function commitBaseline(data: ScanRefreshWorkerCommitRequest): void {
  if (!workerBaseline) throw new Error("Cannot commit an uninitialized worker baseline");
  const staged = workerBaseline.staged;
  if (!staged || staged.requestId !== data.requestId) {
    throw new Error(`Worker result ${data.requestId} is not awaiting commit`);
  }
  if (workerBaseline.generation !== data.generation || staged.generation !== data.generation) {
    throw new Error(
      `Worker commit generation mismatch: expected ${workerBaseline.generation}, received ${data.generation}`,
    );
  }
  workerBaseline.sessions = staged.sessions;
  workerBaseline.meta = staged.meta;
  workerBaseline.generation += 1;
  workerBaseline.staged = null;
}

function postRequestError(data: ScanRefreshWorkerRequest, error: unknown, startedAt: number): void {
  const errorCode = error instanceof AgentUnavailableDuringScanError ? error.code : undefined;
  parentPort?.postMessage({
    type: "error",
    requestId: data.requestId,
    generation: data.generation,
    error: error instanceof Error ? error.message : String(error),
    ...(errorCode ? { errorCode } : {}),
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}

function handleCommit(data: ScanRefreshWorkerCommitRequest): void {
  const startedAt = performance.now();
  try {
    commitBaseline(data);
  } catch (error) {
    postRequestError(data, error, startedAt);
  }
}

function enqueueRequest(data: ScanRefreshWorkerRequest): void {
  requestTail = requestTail
    .then(() => (data.type === "commit" ? handleCommit(data) : handleRequest(data)))
    .catch((error) => {
      appLogger.error("scan.refresh_worker.request_error", {
        request_id: data.requestId,
        request_type: data.type,
        error,
      });
    });
}

const initialRequest = workerData as Partial<ScanRefreshWorkerRequest> | undefined;
if (
  initialRequest?.type === "run" &&
  typeof initialRequest.requestId === "number" &&
  typeof initialRequest.agentName === "string" &&
  typeof initialRequest.pricingGenerationId === "number" &&
  initialRequest.operation != null &&
  Array.isArray(initialRequest.previousSessions) &&
  initialRequest.meta != null
) {
  enqueueRequest(initialRequest as ScanRefreshWorkerRunRequest);
}

parentPort?.on("message", (message: ScanRefreshWorkerRequest) => {
  enqueueRequest(message);
});
