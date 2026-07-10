/**
 * Dashboard analytics — pure aggregation over SessionHead[] with no HTTP or DB
 * coupling. The handler parses request params and supplies file-activity; this
 * module owns the domain math: per-agent metrics, daily buckets, model
 * distribution, and the recent-sessions window.
 */
import type { AgentInfo } from "../types/index.js";
import type { ProjectIdentityKind, SessionHead } from "../types/session.js";
import type {
  DailyTokenBucket,
  DashboardAgentStat,
  DashboardAggregate,
  DashboardDailyBucket,
  DashboardData,
  DashboardRecentSession,
  DashboardTotals,
  ModelDistributionEntry,
} from "../contract/index.js";

export type {
  DailyTokenBucket,
  DashboardAgentStat,
  DashboardAggregate,
  DashboardDailyBucket,
  DashboardData,
  DashboardRecentSession,
  DashboardTotals,
  ModelDistributionEntry,
};

export const DASHBOARD_RECENT_LIMIT = 10;

export interface DashboardScope {
  agent?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
}

interface DashboardAgentAggregate {
  sessions: number;
  messages: number;
  tokens: number;
}

interface DashboardRecentCandidate {
  session: SessionHead;
  activity: number;
}

export interface DashboardOptions {
  byAgentNames: string[];
  scope: DashboardScope;
  from?: number;
  to: number;
  agentInfoMap?: Map<string, AgentInfo>;
}

// --- SessionHead domain helpers (shared with other handlers via re-export) ---

export function getTotalTokens(stats: SessionHead["stats"]): number {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

export function getSessionAgentName(session: SessionHead): string {
  return session.slug.split("/")[0]?.toLowerCase() || "unknown";
}

export function getSessionActivityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

// --- Local-day bucketing helpers ---

export function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Aggregate sessions into dashboard metrics, daily buckets, model distribution,
 * and the recent-sessions window. Pure — no HTTP, no DB.
 */
export function buildDashboard(
  sessions: SessionHead[],
  options: DashboardOptions,
): DashboardAggregate {
  const { byAgentNames, scope, from, to, agentInfoMap } = options;

  const agentMetrics = new Map<string, DashboardAgentAggregate>();
  const agentMetricKeyByName = new Map<string, string>();
  for (const name of byAgentNames) {
    if (scope.agent && name.toLowerCase() !== scope.agent) continue;
    agentMetrics.set(name, { sessions: 0, messages: 0, tokens: 0 });
    agentMetricKeyByName.set(name.toLowerCase(), name);
  }

  let totalSessions = 0;
  let totalMessages = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let hasEstimatedCost = false;
  let latestActivity = 0;
  const recentCandidates: DashboardRecentCandidate[] = [];
  const modelAgg = new Map<string, { tokens: number; sessions: number }>();

  const dailyMap = new Map<string, DashboardDailyBucket>();
  const dailyTokenMap = new Map<string, DailyTokenBucket>();
  if (from != null) {
    const bucketStart = startOfLocalDay(from);
    const bucketDays = Math.floor((startOfLocalDay(to) - bucketStart) / 86400000) + 1;
    for (let i = 0; i < bucketDays; i += 1) {
      const ts = bucketStart + i * 86400000;
      const key = toLocalDateKey(ts);
      dailyMap.set(key, { date: key, sessions: 0, messages: 0 });
      dailyTokenMap.set(key, { date: key, input: 0, output: 0, cache_read: 0, cache_create: 0 });
    }
  }

  for (const session of sessions) {
    const agentName = getSessionAgentName(session);
    if (scope.agent && agentName !== scope.agent) continue;
    if (scope.projectKind || scope.projectKey) {
      const identity = session.project_identity;
      if (
        !identity ||
        !scope.projectKind ||
        !scope.projectKey ||
        identity.kind !== scope.projectKind ||
        identity.key !== scope.projectKey
      ) {
        continue;
      }
    }

    const activity = getSessionActivityTime(session);
    if (from != null && activity < from) continue;
    if (activity > to) continue;

    const messageCount = session.stats.message_count;
    const sessionTokens = getTotalTokens(session.stats);
    totalSessions += 1;
    totalMessages += messageCount;
    totalTokens += sessionTokens;
    totalCost += session.stats.total_cost ?? 0;
    if (session.stats.cost_source === "estimated") hasEstimatedCost = true;
    if (activity > latestActivity) latestActivity = activity;

    const metricKey = agentMetricKeyByName.get(agentName);
    if (metricKey) {
      const metric = agentMetrics.get(metricKey)!;
      metric.sessions += 1;
      metric.messages += messageCount;
      metric.tokens += sessionTokens;
    }

    const key = toLocalDateKey(activity);
    let bucket = dailyMap.get(key);
    if (!bucket) {
      bucket = { date: key, sessions: 0, messages: 0 };
      dailyMap.set(key, bucket);
    }
    bucket.sessions += 1;
    bucket.messages += messageCount;

    let tokenBucket = dailyTokenMap.get(key);
    if (!tokenBucket) {
      tokenBucket = { date: key, input: 0, output: 0, cache_read: 0, cache_create: 0 };
      dailyTokenMap.set(key, tokenBucket);
    }
    const cacheRead = session.stats.total_cache_read_tokens ?? 0;
    const cacheCreate = session.stats.total_cache_create_tokens ?? 0;
    const pureInput = session.stats.total_input_tokens - cacheRead - cacheCreate;
    tokenBucket.input += Math.max(0, pureInput);
    tokenBucket.output += session.stats.total_output_tokens;
    tokenBucket.cache_read += cacheRead;
    tokenBucket.cache_create += cacheCreate;

    if (session.model_usage) {
      for (const [model, tokens] of Object.entries(session.model_usage)) {
        const entry = modelAgg.get(model);
        if (entry) {
          entry.tokens += tokens;
          entry.sessions += 1;
        } else {
          modelAgg.set(model, { tokens, sessions: 1 });
        }
      }
    }

    let recentIndex = recentCandidates.length;
    for (let i = 0; i < recentCandidates.length; i += 1) {
      if (activity > recentCandidates[i]!.activity) {
        recentIndex = i;
        break;
      }
    }
    if (recentIndex < DASHBOARD_RECENT_LIMIT) {
      recentCandidates.splice(recentIndex, 0, { session, activity });
      if (recentCandidates.length > DASHBOARD_RECENT_LIMIT) recentCandidates.pop();
    }
  }

  const perAgent: DashboardAgentStat[] = [...agentMetrics.entries()]
    .map(([name, metrics]) => {
      const info = agentInfoMap?.get(name);
      return {
        name,
        displayName: info?.displayName ?? name,
        icon: info?.icon ?? "",
        sessions: metrics.sessions,
        messages: metrics.messages,
        tokens: metrics.tokens,
      };
    })
    .filter((item) => item.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);

  const dailyActivity = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dailyTokenActivity = [...dailyTokenMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const modelDistribution: ModelDistributionEntry[] = [...modelAgg.entries()]
    .map(([model, { tokens, sessions: count }]) => ({ model, tokens, sessions: count }))
    .sort((a, b) => b.tokens - a.tokens);

  const recentSessions: DashboardRecentSession[] = recentCandidates.map(({ session }) => {
    const agentKey = getSessionAgentName(session);
    return { ...session, agentName: agentKey };
  });

  return {
    totals: {
      sessions: totalSessions,
      messages: totalMessages,
      tokens: totalTokens,
      cost: totalCost,
      cost_source: totalCost > 0 ? (hasEstimatedCost ? "estimated" : "recorded") : undefined,
      latestActivity: latestActivity || undefined,
    },
    perAgent,
    dailyActivity,
    dailyTokenActivity,
    modelDistribution,
    recentSessions,
  };
}
