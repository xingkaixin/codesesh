import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type {
  IdentifiedSessionHead,
  SessionDetail,
  SessionHead,
  SmartTag,
} from "../types/index.js";
import { assertIdentifiedSessionHead } from "../contract/session.js";
import { assertSessionIdentity } from "../contract/session-reference.js";
import { filterSessionTreeByActivityWindow } from "../contract/session-tree.js";
import type {
  AgentScanFailure,
  AgentScanOptions,
  BaseAgent,
  EnumeratedSessionSourceCapability,
  SessionCacheMeta,
  SessionSourceFailure,
} from "../agents/index.js";
import {
  createAgentScanFailure,
  createRegisteredAgents,
  reportAgentScanFailure,
  SessionScanError,
} from "../agents/index.js";
import { filterSessionsByProjectScope } from "../projects/index.js";
import {
  classifySessionTags,
  getSmartTagSourceTimestamp,
  isWorkerLogMessage,
  perf,
  SMART_TAG_CLASSIFIER_REVISION,
  type WorkerLogMessage,
} from "../utils/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { getPricingGeneration } from "../pricing/index.js";
import {
  markAgentCacheInitialized,
  markAgentFullSyncCompleted,
  readCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
  type CachedResult,
} from "./cache/sessions.js";
import {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  buildSessionPersistenceDiff,
} from "./orchestrate.js";
import { inspectAgentRefresh, planAgentScan } from "./agent-scan-plan.js";

export interface ScanOptions {
  /** Filter to specific agent name(s) */
  agents?: string[];
  /** Filter to sessions from a specific project identity or directory scope */
  cwd?: string;
  /** Only include sessions active after this timestamp (ms) */
  from?: number;
  /** Only include sessions active before this timestamp (ms) */
  to?: number;
  /** Use cached scan results if available */
  useCache?: boolean;
  /** Enable smart refresh (fast cache + background incremental scan) */
  smartRefresh?: boolean;
  /** Return cached session heads without validating the filesystem */
  cacheOnly?: boolean;
  /** Persist scan results to the SQLite cache */
  writeCache?: boolean;
  /** Classify sessions by reading full conversation content */
  includeSmartTags?: boolean;
  /** Prefer lightweight metadata over complete statistics when the UI needs a fast first paint */
  fast?: boolean;
  /** URL to the compiled smart-tag worker file; omit to use synchronous fallback */
  smartTagWorkerUrl?: URL | string;
}

export interface LiveSnapshot {
  sessions: IdentifiedSessionHead[];
  byAgent: Record<string, IdentifiedSessionHead[]>;
  agents: BaseAgent[];
  timings?: Record<string, AgentScanTiming>;
  cacheTimestamps?: Record<string, number>;
  cacheFailures?: Record<string, AgentCacheFailure>;
  scanFailures?: Record<string, AgentScanFailure>;
}

export interface AgentCacheFailure {
  agentName: string;
  operation: "read" | "write";
}

/** 扫描状态更新回调 */
export interface ScanProgress {
  agent: string;
  phase: "cache" | "checking" | "incremental" | "complete";
  cachedCount?: number;
  newCount?: number;
  changedCount?: number;
}

export function filterSessions<T extends SessionHead>(sessions: T[], options: ScanOptions): T[] {
  let result = sessions;

  if (options.cwd) {
    result = filterSessionsByProjectScope(result, options.cwd);
  }

  return filterSessionTreeByActivityWindow(result, options.from, options.to);
}

export interface AgentScanTiming {
  cacheLoad?: number;
  checkChanges?: number;
  scan?: number;
  identity?: number;
  tags?: number;
  total: number;
}

export interface SessionTagTiming {
  sessions: number;
  cacheHits: number;
  staleSessions: number;
  failedSessions: number;
  getSessionDataCalls: number;
  getSessionDataMs: number;
  classifySessionTagsCalls: number;
  classifySessionTagsMs: number;
}

function buildAgentScanOptions(
  agent: BaseAgent,
  options: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
): AgentScanOptions {
  return {
    from: options.from,
    to: options.to,
    fast: options.fast,
    includeRelatedSessions: true,
    onProgress: (progress) => {
      onProgress?.({
        agent: agent.name,
        phase: "incremental",
        cachedCount: progress.total,
        newCount: progress.sessions,
        changedCount: progress.processed,
      });
    },
  };
}

type CachePersistence = "persisted" | "failed" | "not-requested";

interface SuccessfulAgentScanResult {
  status: "complete" | "partial";
  agent: BaseAgent;
  heads: IdentifiedSessionHead[];
  cachePersistence: CachePersistence;
  fromCache?: boolean;
  refreshed?: boolean;
  timing?: AgentScanTiming;
  cacheTimestamp?: number;
}

interface FailedAgentScanResult {
  status: "failed";
  agent: BaseAgent;
  failure: AgentScanFailure;
  retainedHeads?: IdentifiedSessionHead[];
  cacheTimestamp?: number;
  timing: AgentScanTiming;
}

type AgentScanResult = SuccessfulAgentScanResult | FailedAgentScanResult;

interface AgentScanExecution {
  agentName: string;
  result: AgentScanResult | null;
  cacheReadFailed: boolean;
}

interface CacheReadState {
  attempted: boolean;
  failed: boolean;
}

function identifiedSessionHeads(sessions: SessionHead[]): IdentifiedSessionHead[] {
  return sessions.map((session) => {
    assertIdentifiedSessionHead(session);
    return session;
  });
}

function finalizeAgentScanFailure(
  agent: BaseAgent,
  failure: AgentScanFailure,
  options: ScanOptions,
  cached: CachedResult | null,
  timing: AgentScanTiming,
  startedAt: number,
): FailedAgentScanResult {
  const retainedHeads = cached
    ? identifiedSessionHeads(filterSessions(agent.filterCachedSessions(cached.sessions), options))
    : undefined;
  reportAgentScanFailure(failure, retainedHeads !== undefined);
  timing.total = performance.now() - startedAt;
  return {
    status: "failed",
    agent,
    failure,
    ...(retainedHeads !== undefined ? { retainedHeads } : {}),
    ...(cached ? { cacheTimestamp: cached.timestamp } : {}),
    timing,
  };
}

type AgentScanFinalization =
  | { kind: "cache-only"; cached: CachedResult }
  | { kind: "unchanged"; cached: CachedResult }
  | {
      kind: "incremental";
      cached: CachedResult;
      changedIds: string[];
      explicitRemovedSessionIds?: string[];
      cacheTimestamp: number;
    };

interface FinalizeAgentScanContext {
  finalization: AgentScanFinalization;
  options: ScanOptions;
  timing: AgentScanTiming;
  agentStart: number;
  completeness: "complete" | "partial";
  onProgress?: (progress: ScanProgress) => void;
}

interface SmartTagWorkerResult {
  id: string;
  tags?: SmartTag[];
  sourceUpdatedAt?: number;
  error?: string;
}

function saveCachedSessionDiff(
  agent: BaseAgent,
  cachedSessions: SessionHead[],
  updatedSessions: SessionHead[],
  changedIds: string[] = [],
  completeness: "complete" | "partial" = "complete",
  explicitRemovedSessionIds: readonly string[] = [],
): boolean {
  const diff = buildSessionPersistenceDiff(cachedSessions, updatedSessions, {
    candidateChangedIds: changedIds,
    completeness,
    explicitRemovedSessionIds,
  });
  const persisted = saveCachedSessionChanges(
    agent.name,
    diff.changedSessions,
    diff.removedSessionIds,
    buildAgentCacheMeta(agent),
  );
  if (persisted === false) {
    getCoreDiagnostics()?.warn("cache.save_failed", {
      agent: agent.name,
      changed_sessions: diff.changedSessions.length,
      removed_sessions: diff.removedSessionIds.length,
    });
  }
  return persisted;
}

function getSmartTagWorkerCount(sessionCount: number): number {
  if (sessionCount < 50) return 1;
  return Math.min(sessionCount, Math.max(1, Math.min(4, availableParallelism() - 1)));
}

function chunkSessions<T>(items: T[], chunkCount: number): T[][] {
  const chunks = Array.from({ length: chunkCount }, () => [] as T[]);
  items.forEach((item, index) => {
    chunks[index % chunkCount]!.push(item);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

export function ensureSessionTagsSync(
  agent: BaseAgent,
  sessions: SessionHead[],
  onProgress?: (processed: number, total: number) => void,
  classifierRevision = SMART_TAG_CLASSIFIER_REVISION,
): { sessions: SessionHead[]; changed: boolean; timing: SessionTagTiming } {
  let changed = false;
  let processed = 0;
  const total = sessions.length;
  const timing: SessionTagTiming = {
    sessions: total,
    cacheHits: 0,
    staleSessions: 0,
    failedSessions: 0,
    getSessionDataCalls: 0,
    getSessionDataMs: 0,
    classifySessionTagsCalls: 0,
    classifySessionTagsMs: 0,
  };

  const tagged = sessions.map((session) => {
    const sourceUpdatedAt = session.time_updated ?? session.time_created;
    const currentTags = Array.isArray(session.smart_tags) ? session.smart_tags : null;
    if (
      currentTags &&
      session.smart_tags_source_updated_at === sourceUpdatedAt &&
      session.smart_tags_classifier_revision === classifierRevision
    ) {
      timing.cacheHits += 1;
      processed += 1;
      onProgress?.(processed, total);
      return session;
    }

    timing.staleSessions += 1;
    try {
      timing.getSessionDataCalls += 1;
      const getSessionDataStartedAt = performance.now();
      let data: SessionDetail;
      try {
        data = agent.getSessionData(session.reference.sessionId);
      } finally {
        timing.getSessionDataMs += performance.now() - getSessionDataStartedAt;
      }

      timing.classifySessionTagsCalls += 1;
      const classifySessionTagsStartedAt = performance.now();
      let tags: SmartTag[];
      try {
        tags = classifySessionTags(data);
      } finally {
        timing.classifySessionTagsMs += performance.now() - classifySessionTagsStartedAt;
      }

      changed = true;
      return {
        ...session,
        smart_tags: tags,
        smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
        smart_tags_classifier_revision: classifierRevision,
      };
    } catch {
      timing.failedSessions += 1;
      return session;
    } finally {
      processed += 1;
      onProgress?.(processed, total);
    }
  });

  return { sessions: tagged, changed, timing };
}

const SMART_TAG_WORKER_TIMEOUT_MS = 300_000;

async function classifySessionTagsInWorker(
  workerUrl: URL | string,
  agentName: string,
  sessionIds: string[],
  meta: Record<string, SessionCacheMeta>,
): Promise<SmartTagWorkerResult[]> {
  const worker = new Worker(workerUrl, {
    workerData: {
      pricingGenerationId: getPricingGeneration().id,
      agentName,
      sessionIds,
      meta,
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<SmartTagWorkerResult[]>((resolveWorker, rejectWorker) => {
      timer = setTimeout(() => {
        rejectWorker(
          new Error(`Smart tag worker timed out after ${SMART_TAG_WORKER_TIMEOUT_MS}ms`),
        );
      }, SMART_TAG_WORKER_TIMEOUT_MS);
      worker.on("message", (message: unknown) => {
        if (isWorkerLogMessage(message)) {
          relayWorkerLogMessage(message);
          return;
        }
        const results = message as SmartTagWorkerResult[];
        // An empty answer to a non-empty request means the worker could not
        // do the job at all (e.g. unresolvable agent) — fail over to the
        // synchronous path instead of silently shipping untagged sessions.
        if (results.length === 0 && sessionIds.length > 0) {
          rejectWorker(new Error("Smart tag worker returned no results"));
          return;
        }
        resolveWorker(results);
      });
      worker.once("error", rejectWorker);
      // Any exit before a result message — including a clean code 0 — must
      // reject; the old `code !== 0` guard left the promise pending forever
      // and hung server startup.
      worker.once("exit", (code) => {
        rejectWorker(new Error(`Smart tag worker exited with code ${code} before responding`));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    worker.terminate().catch(() => {});
  }
}

function relayWorkerLogMessage(message: WorkerLogMessage): void {
  const detail = {
    ...message.data,
    worker_ts: message.ts,
    worker_pid: message.pid,
    worker_thread_id: message.threadId,
    worker_level: message.level,
  };
  if (message.level === "warn" || message.level === "error") {
    getCoreDiagnostics()?.warn(message.event, detail);
    return;
  }
  getCoreDiagnostics()?.info?.(message.event, detail);
}

async function ensureSessionTags(
  agent: BaseAgent,
  sessions: SessionHead[],
  workerUrl?: URL | string,
): Promise<{ sessions: SessionHead[]; changed: boolean }> {
  const staleSessions = sessions.filter((session) => {
    const sourceUpdatedAt = session.time_updated ?? session.time_created;
    const currentTags = Array.isArray(session.smart_tags) ? session.smart_tags : null;
    return (
      !currentTags ||
      session.smart_tags_source_updated_at !== sourceUpdatedAt ||
      session.smart_tags_classifier_revision !== SMART_TAG_CLASSIFIER_REVISION
    );
  });

  if (staleSessions.length === 0) {
    return { sessions, changed: false };
  }

  const workerCount = workerUrl ? getSmartTagWorkerCount(staleSessions.length) : 1;
  if (workerCount <= 1) {
    return ensureSessionTagsSync(agent, sessions);
  }

  const meta = buildAgentCacheMeta(agent);
  try {
    const results = (
      await Promise.all(
        chunkSessions(
          staleSessions.map((session) => session.reference.sessionId),
          workerCount,
        ).map((sessionIds) =>
          classifySessionTagsInWorker(workerUrl!, agent.name, sessionIds, meta),
        ),
      )
    ).flat();
    const resultMap = new Map(results.filter((item) => item.tags).map((item) => [item.id, item]));

    return {
      changed: resultMap.size > 0,
      sessions: sessions.map((session) => {
        const result = resultMap.get(session.reference.sessionId);
        if (!result?.tags || result.sourceUpdatedAt == null) return session;
        return {
          ...session,
          smart_tags: result.tags,
          smart_tags_source_updated_at: result.sourceUpdatedAt,
          smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
        };
      }),
    };
  } catch {
    return ensureSessionTagsSync(agent, sessions);
  }
}

export async function finalizeAgentScan(
  agent: BaseAgent,
  sessions: SessionHead[],
  context: FinalizeAgentScanContext,
): Promise<SuccessfulAgentScanResult> {
  const { finalization, options, timing, agentStart, onProgress } = context;
  const isIncremental = finalization.kind === "incremental";
  for (const session of sessions) assertSessionIdentity(session, agent.name);

  if (!isIncremental) {
    onProgress?.({ agent: agent.name, phase: "complete", newCount: sessions.length });
  }

  const identityStart = performance.now();
  const sessionsWithIdentity =
    finalization.kind === "cache-only"
      ? identifiedSessionHeads(sessions)
      : attachMissingProjectIdentities(sessions);
  const identityChanged = sessionsWithIdentity.some(
    (session, index) => session !== sessions[index],
  );
  timing.identity = performance.now() - identityStart;

  let tagged = { sessions: sessionsWithIdentity, changed: false };
  if (finalization.kind !== "cache-only") {
    const tagsStart = performance.now();
    const tagResult =
      options.includeSmartTags === false
        ? tagged
        : await ensureSessionTags(agent, sessionsWithIdentity, options.smartTagWorkerUrl);
    tagged = { ...tagResult, sessions: identifiedSessionHeads(tagResult.sessions) };
    timing.tags = performance.now() - tagsStart;
  }

  let cachePersistence: CachePersistence = "not-requested";
  if (options.writeCache !== false) {
    if (finalization.kind === "incremental") {
      cachePersistence =
        saveCachedSessionDiff(
          agent,
          finalization.cached.sessions,
          tagged.sessions,
          finalization.changedIds,
          context.completeness,
          finalization.explicitRemovedSessionIds,
        ) === false
          ? "failed"
          : "persisted";
    } else if (finalization.kind === "unchanged" && (identityChanged || tagged.changed)) {
      cachePersistence =
        saveCachedSessionDiff(agent, finalization.cached.sessions, tagged.sessions) === false
          ? "failed"
          : "persisted";
    }
  }

  if (isIncremental) {
    onProgress?.({ agent: agent.name, phase: "complete", newCount: tagged.sessions.length });
  }

  const heads = filterSessions(tagged.sessions, options);
  timing.total = performance.now() - agentStart;
  return {
    status: context.completeness,
    agent,
    heads,
    cachePersistence,
    fromCache: true,
    ...(isIncremental ? { refreshed: true } : {}),
    timing,
    cacheTimestamp:
      isIncremental && cachePersistence === "persisted"
        ? finalization.cacheTimestamp
        : finalization.cached.timestamp,
  };
}

async function refreshCachedEnumeratedAgent(
  agent: BaseAgent,
  source: EnumeratedSessionSourceCapability,
  cached: CachedResult,
  options: ScanOptions,
  timing: AgentScanTiming,
  agentStart: number,
  onProgress?: (progress: ScanProgress) => void,
): Promise<SuccessfulAgentScanResult> {
  const scanStartedAt = performance.now();
  const synchronization = source.synchronize(
    { sessions: cached.sessions, meta: cached.meta },
    {
      kind: "refresh",
      scanOptions: {
        onProgress: (progress) => {
          onProgress?.({
            agent: agent.name,
            phase: "incremental",
            cachedCount: progress.total,
            newCount: progress.sessions,
            changedCount: progress.processed,
          });
        },
      },
    },
  );
  timing.scan = performance.now() - scanStartedAt;
  const hasSourceChanges =
    synchronization.detectedSessionIds.length > 0 || synchronization.sourceFailures.length > 0;

  if (!hasSourceChanges) {
    return finalizeAgentScan(agent, synchronization.sessions, {
      finalization: { kind: "unchanged", cached },
      options,
      timing,
      agentStart,
      completeness: synchronization.completeness,
      onProgress,
    });
  }

  onProgress?.({
    agent: agent.name,
    phase: "incremental",
    changedCount: synchronization.detectedSessionIds.length,
  });
  return finalizeAgentScan(agent, synchronization.sessions, {
    finalization: {
      kind: "incremental",
      cached,
      changedIds: synchronization.changedSessionIds,
      explicitRemovedSessionIds: synchronization.explicitRemovedSessionIds,
      cacheTimestamp: Date.now(),
    },
    options,
    timing,
    agentStart,
    completeness: synchronization.completeness,
    onProgress,
  });
}

/**
 * 智能扫描单个 Agent
 * 1. 优先使用缓存立即返回
 * 2. 后台检测变更
 * 3. 增量刷新（仅更新变更的部分）
 */
async function scanAgentSmart(
  agent: BaseAgent,
  options: ScanOptions,
  cacheReadState: CacheReadState,
  onProgress?: (progress: ScanProgress) => void,
): Promise<AgentScanResult | null> {
  const agentStart = performance.now();
  const timing: AgentScanTiming = { total: 0 };
  const useCache = options.useCache ?? true;

  // 1. 尝试加载缓存
  let cached: CachedResult | null = null;
  if (useCache) {
    const t0 = performance.now();
    cacheReadState.attempted = true;
    const outcome = readCachedSessions(agent.name);
    timing.cacheLoad = performance.now() - t0;
    if (outcome.status === "failed") {
      cacheReadState.failed = true;
    } else {
      cached = outcome.value;
    }

    if (cached !== null) {
      // 恢复元数据
      agent.restoreSessionCacheMeta(cached.meta);

      if (options.cacheOnly) {
        const visibleSessions = agent.filterCachedSessions(cached.sessions);
        onProgress?.({
          agent: agent.name,
          phase: "cache",
          cachedCount: visibleSessions.length,
        });
        return finalizeAgentScan(agent, visibleSessions, {
          finalization: { kind: "cache-only", cached },
          options,
          timing,
          agentStart,
          completeness: "partial",
          onProgress,
        });
      }

      const isAvail = agent.isAvailable();
      if (!isAvail) {
        return finalizeAgentScanFailure(
          agent,
          {
            agentName: agent.name,
            stage: "checking availability",
            errorClass: "AgentUnavailableError",
            message: `Agent ${agent.name} is unavailable`,
          },
          options,
          cached,
          timing,
          agentStart,
        );
      }

      // 通知缓存已加载
      onProgress?.({
        agent: agent.name,
        phase: "cache",
        cachedCount: cached.sessions.length,
      });

      onProgress?.({ agent: agent.name, phase: "checking" });

      const refresh = await inspectAgentRefresh(
        agent.sessionSourceAccess,
        cached.timestamp,
        cached.sessions,
      );
      if (refresh.kind !== "synchronize") timing.checkChanges = refresh.checkDurationMs;
      if (refresh.kind === "synchronize") {
        return refreshCachedEnumeratedAgent(
          agent,
          refresh.source,
          cached,
          options,
          timing,
          agentStart,
          onProgress,
        );
      }
      if (refresh.kind === "failed") {
        return finalizeAgentScanFailure(
          agent,
          {
            agentName: agent.name,
            stage: "checking for changes",
            sourcePath: refresh.failure.sourcePath,
            errorClass: refresh.failure.errorClass,
            message: refresh.failure.message,
          },
          options,
          cached,
          timing,
          agentStart,
        );
      }

      if (refresh.kind === "scan") {
        const checkResult = refresh.check;
        onProgress?.({
          agent: agent.name,
          phase: "incremental",
          changedCount: checkResult.changedIds?.length,
        });

        const t2 = performance.now();
        const scanOptions = buildAgentScanOptions(agent, options, onProgress);
        const updatedSessions = await Promise.resolve(
          refresh.source.incrementalScan(
            cached.sessions,
            checkResult.changedIds || [],
            checkResult.refs,
            scanOptions,
          ),
        );
        timing.scan = performance.now() - t2;
        refresh.source.commitChangeCheck();

        return finalizeAgentScan(agent, updatedSessions, {
          finalization: {
            kind: "incremental",
            cached,
            changedIds: checkResult.changedIds ?? [],
            cacheTimestamp: checkResult.timestamp,
          },
          options,
          timing,
          agentStart,
          completeness:
            options.from == null &&
            options.to == null &&
            (checkResult.sourceFailures?.length ?? 0) === 0
              ? "complete"
              : "partial",
          onProgress,
        });
      }

      refresh.source.commitChangeCheck();
      return finalizeAgentScan(agent, cached.sessions, {
        finalization: { kind: "unchanged", cached },
        options,
        timing,
        agentStart,
        completeness: "complete",
        onProgress,
      });
    }
  }

  if (options.cacheOnly) {
    timing.total = performance.now() - agentStart;
    return null;
  }

  // 无缓存或缓存失效，执行完整扫描
  return scanAgentFull(agent, options, cached, cacheReadState, onProgress, timing, agentStart);
}

/**
 * 完整扫描 Agent（无缓存时使用）
 */
async function scanAgentFull(
  agent: BaseAgent,
  options: ScanOptions,
  cached: CachedResult | null,
  cacheReadState: CacheReadState,
  onProgress?: (progress: ScanProgress) => void,
  timing: AgentScanTiming = { total: 0 },
  agentStart = performance.now(),
): Promise<AgentScanResult | null> {
  const availMarker = perf.start(`agent:${agent.name}:isAvailable`);
  const isAvail = agent.isAvailable();
  perf.end(availMarker);

  if (!isAvail) {
    return null;
  }

  try {
    const scanMarker = perf.start(`agent:${agent.name}:scan`);
    const t0 = performance.now();
    const agentScanOptions = buildAgentScanOptions(agent, options, onProgress);
    let heads: SessionHead[];
    let sourceFailures: SessionSourceFailure[] = [];
    const scanPlan = planAgentScan(agent.sessionSourceAccess, "reload");
    if (scanPlan.kind === "synchronize") {
      if (!cacheReadState.attempted) {
        cacheReadState.attempted = true;
        const outcome = readCachedSessions(agent.name);
        if (outcome.status === "failed") {
          cacheReadState.failed = true;
        } else {
          cached = outcome.value;
        }
      }
      const synchronization = scanPlan.source.synchronize(
        { sessions: cached?.sessions ?? [], meta: cached?.meta ?? {} },
        { kind: scanPlan.requestKind, scanOptions: agentScanOptions },
      );
      heads = synchronization.sessions;
      sourceFailures = synchronization.sourceFailures;
    } else {
      heads = agent.scan(agentScanOptions);
    }
    for (const session of heads) assertSessionIdentity(session, agent.name);
    perf.end(scanMarker);
    timing.scan = performance.now() - t0;

    const t1 = performance.now();
    const headsWithIdentity = attachMissingProjectIdentities(heads);
    timing.identity = performance.now() - t1;

    const t2 = performance.now();
    const tagResult =
      options.includeSmartTags === false
        ? { sessions: headsWithIdentity, changed: false }
        : await ensureSessionTags(agent, headsWithIdentity, options.smartTagWorkerUrl);
    const tagged = { ...tagResult, sessions: identifiedSessionHeads(tagResult.sessions) };
    timing.tags = performance.now() - t2;

    // 收集元数据
    const meta = buildAgentCacheMeta(agent);

    let cachePersistence: CachePersistence = "not-requested";
    if (options.writeCache !== false) {
      const isFullWindow = options.from == null && options.to == null;
      const persisted = saveCachedSessions(agent.name, tagged.sessions, meta, {
        completeness: isFullWindow && sourceFailures.length === 0 ? "complete" : "partial",
      });
      if (persisted !== false) {
        cachePersistence = "persisted";
        markAgentCacheInitialized(agent.name);
        if (
          isFullWindow &&
          sourceFailures.length === 0 &&
          !markAgentFullSyncCompleted(agent.name)
        ) {
          getCoreDiagnostics()?.warn("cache.full_sync_marker_failed", { agent: agent.name });
        }
      } else {
        cachePersistence = "failed";
        getCoreDiagnostics()?.warn("cache.save_failed", {
          agent: agent.name,
          sessions: tagged.sessions.length,
        });
      }
    }

    onProgress?.({ agent: agent.name, phase: "complete", newCount: tagged.sessions.length });

    const filtered = filterSessions(tagged.sessions, options);
    timing.total = performance.now() - agentStart;
    return {
      status:
        options.from == null && options.to == null && sourceFailures.length === 0
          ? "complete"
          : "partial",
      agent,
      heads: filtered,
      cachePersistence,
      fromCache: false,
      timing,
    };
  } catch (err) {
    if (err instanceof SessionScanError) throw err;
    throw new SessionScanError(agent.name, "scanning sessions", { cause: err });
  }
}

async function scanAgentOutcome(
  agent: BaseAgent,
  options: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
): Promise<AgentScanExecution> {
  const startedAt = performance.now();
  const cacheReadState: CacheReadState = { attempted: false, failed: false };
  try {
    return {
      agentName: agent.name,
      result: await scanAgentSmart(agent, options, cacheReadState, onProgress),
      cacheReadFailed: cacheReadState.failed,
    };
  } catch (error) {
    let cached: CachedResult | null = null;
    if (options.useCache ?? true) {
      cacheReadState.attempted = true;
      const outcome = readCachedSessions(agent.name);
      if (outcome.status === "failed") {
        cacheReadState.failed = true;
      } else {
        cached = outcome.value;
      }
    }
    if (cached) agent.restoreSessionCacheMeta(cached.meta);
    const failure = createAgentScanFailure(agent.name, "scanning sessions", error);
    return {
      agentName: agent.name,
      result: finalizeAgentScanFailure(agent, failure, options, cached, { total: 0 }, startedAt),
      cacheReadFailed: cacheReadState.failed,
    };
  }
}

/**
 * 主扫描函数 - 并行扫描所有 Agent
 */
export async function scanSessions(
  options: ScanOptions = {},
  onProgress?: (progress: ScanProgress) => void,
): Promise<LiveSnapshot> {
  const scanMarker = perf.start("scanSessions");
  const agents = createRegisteredAgents();
  const byAgent: Record<string, IdentifiedSessionHead[]> = {};
  const allSessions: IdentifiedSessionHead[] = [];
  const availableAgents: BaseAgent[] = [];
  const cacheTimestamps: Record<string, number> = {};
  const cacheFailures: Record<string, AgentCacheFailure> = {};
  const scanFailures: Record<string, AgentScanFailure> = {};

  const agentFilter = options.agents?.length
    ? new Set(options.agents.map((a) => a.toLowerCase()))
    : null;

  // 过滤需要扫描的 Agent
  const agentsToScan = agents.filter((agent) => {
    if (agentFilter && !agentFilter.has(agent.name.toLowerCase())) {
      return false;
    }
    return true;
  });

  // 并行扫描所有 Agent
  const scanPromises = agentsToScan.map((agent) => scanAgentOutcome(agent, options, onProgress));

  const results = await Promise.all(scanPromises);

  // 处理结果
  const timings: Record<string, AgentScanTiming> = {};
  for (const execution of results) {
    const { result } = execution;
    if (execution.cacheReadFailed) {
      cacheFailures[execution.agentName] = {
        agentName: execution.agentName,
        operation: "read",
      };
    }
    if (result) {
      availableAgents.push(result.agent);
      if (result.status === "failed") {
        scanFailures[result.agent.name] = result.failure;
        if (result.retainedHeads !== undefined) {
          byAgent[result.agent.name] = result.retainedHeads;
          allSessions.push(...result.retainedHeads);
        }
      } else {
        byAgent[result.agent.name] = result.heads;
        allSessions.push(...result.heads);
        if (result.cachePersistence === "failed") {
          cacheFailures[result.agent.name] = {
            agentName: result.agent.name,
            operation: "write",
          };
        }
      }
      if (result.timing) {
        timings[result.agent.name] = result.timing;
      }
      if (result.cacheTimestamp != null) {
        cacheTimestamps[result.agent.name] = result.cacheTimestamp;
      }
    }
  }

  perf.end(scanMarker);
  return {
    sessions: allSessions,
    byAgent,
    agents: availableAgents,
    timings,
    cacheTimestamps: Object.keys(cacheTimestamps).length > 0 ? cacheTimestamps : undefined,
    cacheFailures: Object.keys(cacheFailures).length > 0 ? cacheFailures : undefined,
    scanFailures: Object.keys(scanFailures).length > 0 ? scanFailures : undefined,
  };
}
