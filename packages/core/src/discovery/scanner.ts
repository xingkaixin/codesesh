import { resolve, sep } from "node:path";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ProjectIdentity, SessionHead, SmartTag } from "../types/index.js";
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { createRegisteredAgents } from "../agents/index.js";
import { computeIdentity, realFs } from "../projects/index.js";
import { classifySessionTags, getSmartTagSourceTimestamp, perf } from "../utils/index.js";
import { loadCachedSessions, saveCachedSessions } from "./cache.js";

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
  /** Persist scan results to the SQLite cache */
  writeCache?: boolean;
  /** Classify sessions by reading full conversation content */
  includeSmartTags?: boolean;
  /** Prefer lightweight metadata over complete statistics when the UI needs a fast first paint */
  fast?: boolean;
}

export interface ScanResult {
  sessions: SessionHead[];
  byAgent: Record<string, SessionHead[]>;
  agents: BaseAgent[];
}

/** 扫描状态更新回调 */
export interface ScanProgress {
  agent: string;
  phase: "cache" | "checking" | "incremental" | "complete";
  cachedCount?: number;
  newCount?: number;
  changedCount?: number;
}

/**
 * Bidirectional path scope match (mirrors agent-dump's is_path_scope_match).
 * Matches when:
 *   - paths are equal
 *   - queryPath is a parent of sessionPath  (session is inside the queried project)
 *   - sessionPath is a parent of queryPath  (session root contains the queried path)
 */
function isPathScopeMatch(queryPath: string, sessionPath: string): boolean {
  if (!sessionPath) return false;
  const q = resolve(queryPath);
  const s = resolve(sessionPath);
  const sepNorm = (p: string) => p.replaceAll(sep, "/");
  const sn = sepNorm(s);
  const qn = sepNorm(q);
  return sn === qn || sn.startsWith(qn + "/") || qn.startsWith(sn + "/");
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

function isProjectScopeMatch(queryPath: string, session: SessionHead): boolean {
  if (!session.directory) return false;
  const queryIdentity = computeIdentity(queryPath, realFs);
  if (session.project_identity?.key === queryIdentity.key) return true;
  return isPathScopeMatch(queryPath, session.directory);
}

export function filterSessions(sessions: SessionHead[], options: ScanOptions): SessionHead[] {
  let result = sessions;

  if (options.cwd) {
    const cwd = options.cwd;
    result = result.filter((s) => isProjectScopeMatch(cwd, s));
  }

  if (options.from != null) {
    result = result.filter((s) => (s.time_updated ?? s.time_created) >= options.from!);
  }

  if (options.to != null) {
    result = result.filter((s) => (s.time_updated ?? s.time_created) <= options.to!);
  }

  return result;
}

interface AgentScanResult {
  agent: BaseAgent;
  heads: SessionHead[];
  fromCache?: boolean;
  refreshed?: boolean;
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

function getSmartTagWorkerCount(sessionCount: number): number {
  if (sessionCount < 8) return 1;
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
  agentName: string,
  sessionIds: string[],
): Promise<SmartTagWorkerResult[]> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");

        (async () => {
          const {
            createRegisteredAgents,
            classifySessionTags,
            getSmartTagSourceTimestamp,
          } = await import("@codesesh/core");

          const agent = createRegisteredAgents().find((item) => item.name === workerData.agentName);
          const results = [];

          if (agent) {
            for (const sessionId of workerData.sessionIds) {
              try {
                const data = agent.getSessionData(sessionId);
                results.push({
                  id: sessionId,
                  tags: classifySessionTags(data),
                  sourceUpdatedAt: getSmartTagSourceTimestamp(data),
                });
              } catch (error) {
                results.push({
                  id: sessionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          parentPort?.postMessage(results);
        })().catch((error) => {
          parentPort?.postMessage([
            {
              id: "",
              error: error instanceof Error ? error.message : String(error),
            },
          ]);
        });
      `,
      {
        eval: true,
        workerData: { agentName, sessionIds },
      },
    );

    worker.once("message", (results: SmartTagWorkerResult[]) => {
      resolveWorker(results);
    });
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
): Promise<{ sessions: SessionHead[]; changed: boolean }> {
  const staleSessions = sessions.filter((session) => {
    const sourceUpdatedAt = session.time_updated ?? session.time_created;
    const currentTags = Array.isArray(session.smart_tags) ? session.smart_tags : null;
    return !currentTags || session.smart_tags_source_updated_at !== sourceUpdatedAt;
  });

  if (staleSessions.length === 0) {
    return { sessions, changed: false };
  }

  const workerCount = getSmartTagWorkerCount(staleSessions.length);
  if (workerCount <= 1) {
    return ensureSessionTagsSync(agent, sessions);
  }

  try {
    const results = (
      await Promise.all(
        chunkSessions(
          staleSessions.map((session) => session.id),
          workerCount,
        ).map((sessionIds) => classifySessionTagsInWorker(agent.name, sessionIds)),
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
  const useCache = options.useCache ?? true;
  const canValidateCache = Boolean(agent.checkForChanges && agent.incrementalScan);

  // 1. 尝试加载缓存
  if (useCache) {
    const cached = loadCachedSessions(agent.name);
    if (cached !== null) {
      // 恢复元数据
      if (agent.setSessionMetaMap) {
        const metaMap = new Map<string, SessionCacheMeta>();
        for (const [id, meta] of Object.entries(cached.meta)) {
          metaMap.set(id, meta);
        }
        agent.setSessionMetaMap(metaMap);
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

      if (canValidateCache) {
        onProgress?.({ agent: agent.name, phase: "checking" });

        const checkResult = await Promise.resolve(
          agent.checkForChanges!(cached.timestamp, cached.sessions),
        );

        if (checkResult.hasChanges) {
          onProgress?.({
            agent: agent.name,
            phase: "incremental",
            changedCount: checkResult.changedIds?.length,
          });

          const updatedSessions = await Promise.resolve(
            agent.incrementalScan!(cached.sessions, checkResult.changedIds || []),
          );
          const sessionsWithIdentity = attachProjectIdentities(updatedSessions);
          const tagged =
            options.includeSmartTags === false
              ? { sessions: sessionsWithIdentity, changed: false }
              : await ensureSessionTags(agent, sessionsWithIdentity);

          if (options.writeCache !== false && options.from == null && options.to == null) {
            saveCachedSessions(agent.name, tagged.sessions, buildAgentCacheMeta(agent));
          }

          onProgress?.({
            agent: agent.name,
            phase: "complete",
            newCount: tagged.sessions.length,
          });

          const filtered = filterSessions(tagged.sessions, options);
          return { agent, heads: filtered, fromCache: true, refreshed: true };
        }

        onProgress?.({ agent: agent.name, phase: "complete", newCount: cached.sessions.length });
      }

      const cachedWithIdentity = attachProjectIdentities(cached.sessions);
      const tagged =
        options.includeSmartTags === false
          ? { sessions: cachedWithIdentity, changed: false }
          : await ensureSessionTags(agent, cachedWithIdentity);
      if (
        tagged.changed &&
        options.writeCache !== false &&
        options.from == null &&
        options.to == null
      ) {
        saveCachedSessions(agent.name, tagged.sessions, buildAgentCacheMeta(agent));
      }

      const filtered = filterSessions(tagged.sessions, options);
      return { agent, heads: filtered, fromCache: true };
    }
  }

  // 无缓存或缓存失效，执行完整扫描
  return scanAgentFull(agent, options, onProgress);
}

/**
 * 完整扫描 Agent（无缓存时使用）
 */
async function scanAgentFull(
  agent: BaseAgent,
  options: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
): Promise<AgentScanResult | null> {
  const availMarker = perf.start(`agent:${agent.name}:isAvailable`);
  const isAvail = agent.isAvailable();
  perf.end(availMarker);

  if (!isAvail) {
    return null;
  }

  try {
    const scanMarker = perf.start(`agent:${agent.name}:scan`);
    const heads = agent.scan({ from: options.from, to: options.to, fast: options.fast });
    perf.end(scanMarker);
    const headsWithIdentity = attachProjectIdentities(heads);
    const tagged =
      options.includeSmartTags === false
        ? { sessions: headsWithIdentity, changed: false }
        : await ensureSessionTags(agent, headsWithIdentity);

    // 收集元数据
    const meta = buildAgentCacheMeta(agent);

    // 保存到缓存
    if (options.writeCache !== false && options.from == null && options.to == null) {
      saveCachedSessions(agent.name, tagged.sessions, meta);
    }

    onProgress?.({ agent: agent.name, phase: "complete", newCount: tagged.sessions.length });

    const filtered = filterSessions(tagged.sessions, options);
    return { agent, heads: filtered, fromCache: false };
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
  for (const result of results) {
    if (result) {
      availableAgents.push(result.agent);
      byAgent[result.agent.name] = result.heads;
      allSessions.push(...result.heads);
    }
  }

  perf.end(scanMarker);
  return { sessions: allSessions, byAgent, agents: availableAgents };
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
