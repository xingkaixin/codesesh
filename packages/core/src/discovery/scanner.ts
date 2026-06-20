import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ProjectIdentity, SessionHead, SmartTag } from "../types/index.js";
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { createRegisteredAgents } from "../agents/index.js";
import { computeIdentity, filterSessionsByProjectScope, realFs } from "../projects/index.js";
import { classifySessionTags, getSmartTagSourceTimestamp, perf } from "../utils/index.js";
import {
  loadCachedSessions,
  markAgentCacheInitialized,
  saveCachedSessionChanges,
  saveCachedSessions,
  type SessionHeadChange,
} from "./cache.js";

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

export interface ScanResult {
  sessions: SessionHead[];
  byAgent: Record<string, SessionHead[]>;
  agents: BaseAgent[];
  timings?: Record<string, AgentScanTiming>;
  cacheTimestamps?: Record<string, number>;
}

/** 扫描状态更新回调 */
export interface ScanProgress {
  agent: string;
  phase: "cache" | "checking" | "incremental" | "complete";
  cachedCount?: number;
  newCount?: number;
  changedCount?: number;
}

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

function attachProjectIdentities(sessions: SessionHead[]): SessionHead[] {
  const resolveIdentity = createIdentityResolver();
  return sessions.map((session) => {
    if (session.project_identity) return session;
    return {
      ...session,
      project_identity: resolveIdentity(session.directory),
    };
  });
}

export function filterSessions(sessions: SessionHead[], options: ScanOptions): SessionHead[] {
  let result = sessions;

  if (options.cwd) {
    result = filterSessionsByProjectScope(result, options.cwd);
  }

  if (options.from != null) {
    result = result.filter((s) => (s.time_updated ?? s.time_created) >= options.from!);
  }

  if (options.to != null) {
    result = result.filter((s) => (s.time_updated ?? s.time_created) <= options.to!);
  }

  return result;
}

export interface AgentScanTiming {
  cacheLoad?: number;
  checkChanges?: number;
  scan?: number;
  identity?: number;
  tags?: number;
  total: number;
}

interface AgentScanResult {
  agent: BaseAgent;
  heads: SessionHead[];
  fromCache?: boolean;
  refreshed?: boolean;
  timing?: AgentScanTiming;
  cacheTimestamp?: number;
}

interface SmartTagWorkerResult {
  id: string;
  tags?: SmartTag[];
  sourceUpdatedAt?: number;
  error?: string;
}

function buildAgentCacheMeta(agent: BaseAgent): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  const meta: Record<string, SessionCacheMeta> = {};
  if (!metaMap) return meta;

  for (const [id, data] of metaMap.entries()) {
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }

  return meta;
}

function sessionCacheValue(session: SessionHead): string {
  return JSON.stringify(session);
}

function buildCacheChanges(
  cachedSessions: SessionHead[],
  updatedSessions: SessionHead[],
  changedIds: string[] = [],
): { changes: SessionHeadChange[]; removedSessionIds: string[] } {
  const cachedMap = new Map(cachedSessions.map((session) => [session.id, session]));
  const updatedIds = new Set(updatedSessions.map((session) => session.id));
  const changedIdSet = new Set(changedIds);
  const removedSessionIds = cachedSessions
    .filter((session) => !updatedIds.has(session.id))
    .map((session) => session.id);
  const changes: SessionHeadChange[] = [];

  updatedSessions.forEach((session, sortIndex) => {
    const cached = cachedMap.get(session.id);
    if (
      !cached ||
      changedIdSet.has(session.id) ||
      (cached !== session && sessionCacheValue(cached) !== sessionCacheValue(session))
    ) {
      changes.push({ session, sortIndex });
    }
  });

  return { changes, removedSessionIds };
}

function saveCachedSessionDiff(
  agent: BaseAgent,
  cachedSessions: SessionHead[],
  updatedSessions: SessionHead[],
  changedIds: string[] = [],
): void {
  const diff = buildCacheChanges(cachedSessions, updatedSessions, changedIds);
  saveCachedSessionChanges(
    agent.name,
    diff.changes,
    diff.removedSessionIds,
    buildAgentCacheMeta(agent),
  );
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

function ensureSessionTagsSync(
  agent: BaseAgent,
  sessions: SessionHead[],
): { sessions: SessionHead[]; changed: boolean } {
  let changed = false;

  const tagged = sessions.map((session) => {
    const sourceUpdatedAt = session.time_updated ?? session.time_created;
    const currentTags = Array.isArray(session.smart_tags) ? session.smart_tags : null;
    if (currentTags && session.smart_tags_source_updated_at === sourceUpdatedAt) {
      return session;
    }

    try {
      const data = agent.getSessionData(session.id);
      const tags = classifySessionTags(data);
      changed = true;
      return {
        ...session,
        smart_tags: tags,
        smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      };
    } catch {
      return session;
    }
  });

  return { sessions: tagged, changed };
}

async function classifySessionTagsInWorker(
  workerUrl: URL | string,
  agentName: string,
  sessionIds: string[],
  meta: Record<string, SessionCacheMeta>,
): Promise<SmartTagWorkerResult[]> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(workerUrl, {
      workerData: { agentName, sessionIds, meta },
    });
    worker.once("message", (results: SmartTagWorkerResult[]) => resolveWorker(results));
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`Smart tag worker exited with code ${code}`));
      }
    });
  });
}

async function ensureSessionTags(
  agent: BaseAgent,
  sessions: SessionHead[],
  workerUrl?: URL | string,
): Promise<{ sessions: SessionHead[]; changed: boolean }> {
  const staleSessions = sessions.filter((session) => {
    const sourceUpdatedAt = session.time_updated ?? session.time_created;
    const currentTags = Array.isArray(session.smart_tags) ? session.smart_tags : null;
    return !currentTags || session.smart_tags_source_updated_at !== sourceUpdatedAt;
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
          staleSessions.map((session) => session.id),
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
        const result = resultMap.get(session.id);
        if (!result?.tags || result.sourceUpdatedAt == null) return session;
        return {
          ...session,
          smart_tags: result.tags,
          smart_tags_source_updated_at: result.sourceUpdatedAt,
        };
      }),
    };
  } catch {
    return ensureSessionTagsSync(agent, sessions);
  }
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
  onProgress?: (progress: ScanProgress) => void,
): Promise<AgentScanResult | null> {
  const agentStart = performance.now();
  const timing: AgentScanTiming = { total: 0 };
  const useCache = options.useCache ?? true;

  // 1. 尝试加载缓存
  if (useCache) {
    const t0 = performance.now();
    const cached = loadCachedSessions(agent.name);
    timing.cacheLoad = performance.now() - t0;

    if (cached !== null) {
      // 恢复元数据
      const metaMap = new Map<string, SessionCacheMeta>();
      for (const [id, meta] of Object.entries(cached.meta)) {
        metaMap.set(id, meta);
      }
      agent.setSessionMetaMap(metaMap);

      if (options.cacheOnly) {
        onProgress?.({
          agent: agent.name,
          phase: "cache",
          cachedCount: cached.sessions.length,
        });
        onProgress?.({ agent: agent.name, phase: "complete", newCount: cached.sessions.length });
        const t3 = performance.now();
        const cachedWithIdentity = attachProjectIdentities(cached.sessions);
        timing.identity = performance.now() - t3;

        const filtered = filterSessions(cachedWithIdentity, options);
        timing.total = performance.now() - agentStart;
        return {
          agent,
          heads: filtered,
          fromCache: true,
          timing,
          cacheTimestamp: cached.timestamp,
        };
      }

      const isAvail = agent.isAvailable();
      if (!isAvail) {
        return null;
      }

      // 通知缓存已加载
      onProgress?.({
        agent: agent.name,
        phase: "cache",
        cachedCount: cached.sessions.length,
      });

      onProgress?.({ agent: agent.name, phase: "checking" });

      const t1 = performance.now();
      const checkResult = await Promise.resolve(
        agent.checkForChanges(cached.timestamp, cached.sessions),
      );
      timing.checkChanges = performance.now() - t1;

      if (checkResult.hasChanges) {
        onProgress?.({
          agent: agent.name,
          phase: "incremental",
          changedCount: checkResult.changedIds?.length,
        });

        const t2 = performance.now();
        const updatedSessions = await Promise.resolve(
          agent.incrementalScan(cached.sessions, checkResult.changedIds || []),
        );
        timing.scan = performance.now() - t2;

        const t3 = performance.now();
        const sessionsWithIdentity = attachProjectIdentities(updatedSessions);
        timing.identity = performance.now() - t3;

        const t4 = performance.now();
        const tagged =
          options.includeSmartTags === false
            ? { sessions: sessionsWithIdentity, changed: false }
            : await ensureSessionTags(agent, sessionsWithIdentity, options.smartTagWorkerUrl);
        timing.tags = performance.now() - t4;

        if (options.writeCache !== false) {
          saveCachedSessionDiff(
            agent,
            cached.sessions,
            tagged.sessions,
            checkResult.changedIds ?? [],
          );
        }

        onProgress?.({
          agent: agent.name,
          phase: "complete",
          newCount: tagged.sessions.length,
        });

        const filtered = filterSessions(tagged.sessions, options);
        timing.total = performance.now() - agentStart;
        return {
          agent,
          heads: filtered,
          fromCache: true,
          refreshed: true,
          timing,
          cacheTimestamp: checkResult.timestamp,
        };
      }

      onProgress?.({ agent: agent.name, phase: "complete", newCount: cached.sessions.length });

      const t3 = performance.now();
      const cachedWithIdentity = attachProjectIdentities(cached.sessions);
      timing.identity = performance.now() - t3;

      const t4 = performance.now();
      const tagged =
        options.includeSmartTags === false
          ? { sessions: cachedWithIdentity, changed: false }
          : await ensureSessionTags(agent, cachedWithIdentity, options.smartTagWorkerUrl);
      timing.tags = performance.now() - t4;

      if (tagged.changed && options.writeCache !== false) {
        saveCachedSessionDiff(agent, cached.sessions, tagged.sessions);
      }

      const filtered = filterSessions(tagged.sessions, options);
      timing.total = performance.now() - agentStart;
      return {
        agent,
        heads: filtered,
        fromCache: true,
        timing,
        cacheTimestamp: cached.timestamp,
      };
    }
  }

  if (options.cacheOnly) {
    timing.total = performance.now() - agentStart;
    return null;
  }

  // 无缓存或缓存失效，执行完整扫描
  return scanAgentFull(agent, options, onProgress, timing, agentStart);
}

/**
 * 完整扫描 Agent（无缓存时使用）
 */
async function scanAgentFull(
  agent: BaseAgent,
  options: ScanOptions,
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
    const heads = agent.scan({
      from: options.from,
      to: options.to,
      fast: options.fast,
      onProgress: (progress) => {
        onProgress?.({
          agent: agent.name,
          phase: "incremental",
          cachedCount: progress.total,
          newCount: progress.sessions,
          changedCount: progress.processed,
        });
      },
    });
    perf.end(scanMarker);
    timing.scan = performance.now() - t0;

    const t1 = performance.now();
    const headsWithIdentity = attachProjectIdentities(heads);
    timing.identity = performance.now() - t1;

    const t2 = performance.now();
    const tagged =
      options.includeSmartTags === false
        ? { sessions: headsWithIdentity, changed: false }
        : await ensureSessionTags(agent, headsWithIdentity, options.smartTagWorkerUrl);
    timing.tags = performance.now() - t2;

    // 收集元数据
    const meta = buildAgentCacheMeta(agent);

    // 保存到缓存
    if (options.writeCache !== false && options.from == null && options.to == null) {
      saveCachedSessions(agent.name, tagged.sessions, meta);
      markAgentCacheInitialized(agent.name);
    }

    onProgress?.({ agent: agent.name, phase: "complete", newCount: tagged.sessions.length });

    const filtered = filterSessions(tagged.sessions, options);
    timing.total = performance.now() - agentStart;
    return { agent, heads: filtered, fromCache: false, timing };
  } catch (err) {
    console.error(`Error scanning ${agent.name}:`, err);
    return { agent, heads: [], fromCache: false };
  }
}

/**
 * 主扫描函数 - 并行扫描所有 Agent
 */
export async function scanSessions(
  options: ScanOptions = {},
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  const scanMarker = perf.start("scanSessions");
  const agents = createRegisteredAgents();
  const byAgent: Record<string, SessionHead[]> = {};
  const allSessions: SessionHead[] = [];
  const availableAgents: BaseAgent[] = [];
  const cacheTimestamps: Record<string, number> = {};

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
  const scanPromises = agentsToScan.map((agent) => scanAgentSmart(agent, options, onProgress));

  const results = await Promise.all(scanPromises);

  // 处理结果
  const timings: Record<string, AgentScanTiming> = {};
  for (const result of results) {
    if (result) {
      availableAgents.push(result.agent);
      byAgent[result.agent.name] = result.heads;
      allSessions.push(...result.heads);
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
  };
}

/**
 * 异步扫描（带增量更新支持）
 */
export async function scanSessionsAsync(
  options: ScanOptions = {},
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  return scanSessions(options, onProgress);
}
