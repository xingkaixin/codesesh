import { resolve, sep } from "node:path";
import type { SessionHead } from "../types/index.js";
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { createRegisteredAgents } from "../agents/index.js";
import { classifySessionTags, getSmartTagSourceTimestamp, perf } from "../utils/index.js";
import { loadCachedSessions, saveCachedSessions } from "./cache.js";

export interface ScanOptions {
  /** Filter to specific agent name(s) */
  agents?: string[];
  /** Filter to sessions from a specific project directory (substring match) */
  cwd?: string;
  /** Only include sessions created after this timestamp (ms) */
  from?: number;
  /** Only include sessions created before this timestamp (ms) */
  to?: number;
  /** Use cached scan results if available */
  useCache?: boolean;
  /** Enable smart refresh (fast cache + background incremental scan) */
  smartRefresh?: boolean;
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

export function filterSessions(sessions: SessionHead[], options: ScanOptions): SessionHead[] {
  let result = sessions;

  if (options.cwd) {
    const cwd = options.cwd;
    result = result.filter((s) => isPathScopeMatch(cwd, s.directory));
  }

  if (options.from != null) {
    result = result.filter((s) => s.time_created >= options.from!);
  }

  if (options.to != null) {
    result = result.filter((s) => s.time_created <= options.to!);
  }

  return result;
}

interface AgentScanResult {
  agent: BaseAgent;
  heads: SessionHead[];
  fromCache?: boolean;
  refreshed?: boolean;
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

function ensureSessionTags(
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
          const tagged = ensureSessionTags(agent, updatedSessions);

          saveCachedSessions(agent.name, tagged.sessions, buildAgentCacheMeta(agent));

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

      const tagged = ensureSessionTags(agent, cached.sessions);
      if (tagged.changed) {
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
    const heads = agent.scan();
    perf.end(scanMarker);
    const tagged = ensureSessionTags(agent, heads);

    // 收集元数据
    const meta = buildAgentCacheMeta(agent);

    // 保存到缓存
    saveCachedSessions(agent.name, tagged.sessions, meta);

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
