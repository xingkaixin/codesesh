import type { IdentifiedSessionHead, SessionHead } from "../types/index.js";
import { assertIdentifiedSessionHead } from "../contract/session.js";
import { assertSessionIdentity } from "../contract/session-reference.js";
import { filterSessionTreeByActivityWindow } from "../contract/session-tree.js";
import type {
  AgentScanFailure,
  AgentScanOptions,
  BaseAgent,
  EnumeratedSessionSourceCapability,
  SessionSourceSynchronizationTiming,
} from "../agents/index.js";
import {
  createAgentScanFailure,
  createRegisteredAgents,
  reportAgentScanFailure,
  SessionScanError,
} from "../agents/index.js";
import { filterSessionsByProjectScope } from "../projects/index.js";
import { perf } from "../utils/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
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
import {
  beginAgentRefresh,
  executeAgentScanPlan,
  planAgentScan,
  resolveSessionSnapshotCompleteness,
} from "./agent-scan-plan.js";
import { ensureSessionTags } from "./session-tags.js";

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
  sourceEnumeration?: number;
  sourceDiff?: number;
  sourceParse?: number;
  enumeratedSources?: number;
  changedSources?: number;
  processedSources?: number;
  total: number;
}

function applySessionSourceTiming(
  target: AgentScanTiming,
  source: SessionSourceSynchronizationTiming,
): void {
  target.sourceEnumeration = source.enumerationMs;
  target.sourceDiff = source.diffMs;
  target.sourceParse = source.parseMs;
  target.enumeratedSources = source.enumeratedSourceCount;
  target.changedSources = source.changedSourceCount;
  target.processedSources = source.processedSourceCount;
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
  const execution = executeAgentScanPlan(
    agent,
    { kind: "synchronize", requestKind: "refresh", source },
    { sessions: cached.sessions, meta: cached.meta },
    {
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
  );
  timing.scan = performance.now() - scanStartedAt;
  applySessionSourceTiming(timing, execution.sourceSynchronization!.timing);
  const hasSourceChanges =
    execution.detectedSessionIds.length > 0 || execution.sourceFailures.length > 0;

  if (!hasSourceChanges) {
    return finalizeAgentScan(agent, execution.sessions, {
      finalization: { kind: "unchanged", cached },
      options,
      timing,
      agentStart,
      completeness: execution.completeness,
      onProgress,
    });
  }

  onProgress?.({
    agent: agent.name,
    phase: "incremental",
    changedCount: execution.detectedSessionIds.length,
  });
  return finalizeAgentScan(agent, execution.sessions, {
    finalization: {
      kind: "incremental",
      cached,
      changedIds: execution.changedSessionIds,
      explicitRemovedSessionIds: execution.explicitRemovedSessionIds,
      cacheTimestamp: Date.now(),
    },
    options,
    timing,
    agentStart,
    completeness: execution.completeness,
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

      const refreshTransaction = await beginAgentRefresh(agent, {
        initialized: true,
        sinceTimestamp: cached.timestamp,
        cachedSessions: cached.sessions,
      });
      const refresh = refreshTransaction.selection;
      if (refresh.kind === "unavailable") {
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
      if (refresh.kind === "initialize") {
        return scanAgentFull(
          agent,
          options,
          cached,
          cacheReadState,
          onProgress,
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

      if (refresh.kind === "full-scan" || refresh.kind === "incremental-scan") {
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
            checkResult.changedIds ?? [],
            checkResult.refs,
            scanOptions,
          ),
        );
        timing.scan = performance.now() - t2;
        const result = await finalizeAgentScan(agent, updatedSessions, {
          finalization: {
            kind: "incremental",
            cached,
            changedIds: checkResult.changedIds ?? [],
            cacheTimestamp: checkResult.timestamp,
          },
          options,
          timing,
          agentStart,
          completeness: resolveSessionSnapshotCompleteness(
            options,
            checkResult.sourceFailures ?? [],
          ),
          onProgress,
        });
        if (result.cachePersistence === "persisted") refreshTransaction.commit();
        return result;
      }

      const result = await finalizeAgentScan(agent, cached.sessions, {
        finalization: { kind: "unchanged", cached },
        options,
        timing,
        agentStart,
        completeness: "complete",
        onProgress,
      });
      refreshTransaction.commit();
      return result;
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
    const scanPlan = planAgentScan(agent.sessionSourceAccess, "reload");
    if (scanPlan.kind === "synchronize" && !cacheReadState.attempted) {
      cacheReadState.attempted = true;
      const outcome = readCachedSessions(agent.name);
      if (outcome.status === "failed") {
        cacheReadState.failed = true;
      } else {
        cached = outcome.value;
      }
    }
    const execution = executeAgentScanPlan(
      agent,
      scanPlan,
      { sessions: cached?.sessions ?? [], meta: cached?.meta ?? {} },
      agentScanOptions,
    );
    const heads = execution.sessions;
    const sourceFailures = execution.sourceFailures;
    if (execution.sourceSynchronization) {
      applySessionSourceTiming(timing, execution.sourceSynchronization.timing);
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
        completeness: execution.completeness,
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
      status: execution.completeness,
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
