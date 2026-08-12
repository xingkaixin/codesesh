/**
 * Dashboard analytics — pure aggregation over SessionHead[] with no HTTP or DB
 * coupling. The handler parses request params and supplies file-activity; this
 * module owns the domain math: per-agent metrics, daily buckets, model
 * distribution, project ranking and the recent-sessions window.
 *
 * Metrics are *inclusive*: the unit of work is a top-level node (root or
 * orphan) and every descendant's stats roll into it. See contract/session-tree.
 */
import type { AgentInfo } from "../types/index.js";
import type { ProjectIdentityKind, SessionHead } from "../types/session.js";
import type {
  DashboardAgentStat,
  DashboardAggregate,
  DashboardDailyBucket,
  DashboardData,
  DashboardPreviousTotals,
  DashboardProjectRollup,
  DashboardProjectStat,
  DashboardRecentSession,
  DashboardTotals,
  ModelDistributionEntry,
  SessionTree,
  SessionTreeNode,
} from "../contract/index.js";
import {
  addCalendarDays,
  buildSessionTree,
  countCalendarDays,
  filterSessionTreeEntriesByActivityWindow,
  getProjectIdentityKey,
  getSessionAgentKey,
  toCalendarDayKey,
} from "../contract/index.js";

export type {
  DashboardAgentStat,
  DashboardAggregate,
  DashboardDailyBucket,
  DashboardData,
  DashboardPreviousTotals,
  DashboardProjectRollup,
  DashboardProjectStat,
  DashboardRecentSession,
  DashboardTotals,
  ModelDistributionEntry,
};

export const DASHBOARD_RECENT_LIMIT = 10;
export const DASHBOARD_PROJECT_LIMIT = 12;
export const PROJECT_SPARKLINE_DAYS = 14;

export interface DashboardScope {
  agent?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
}

interface DashboardAgentAggregate {
  name: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

interface DashboardProjectAggregate {
  identityKind: ProjectIdentityKind;
  identityKey: string;
  displayName: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  hasEstimatedCost: boolean;
  agentSessions: Map<string, number>;
  sparkline: number[];
}

interface DashboardRecentCandidate {
  session: SessionHead;
  activity: number;
}

interface DashboardAccumulator {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  costRecorded: number;
  costEstimated: number;
  cacheReadTokens: number;
  hasEstimatedCost: boolean;
  agents: Map<string, DashboardAgentAggregate>;
  agentKeys: Set<string>;
  daily: Map<string, DashboardDailyBucket>;
  models: Map<string, { tokens: number; sessions: number }>;
  projects: Map<string, DashboardProjectAggregate>;
  /** Calendar day key → sparkline slot; anchored at the window's `to`. */
  sparklineSlots: Map<string, number>;
  /** Activity-desc, capped at DASHBOARD_RECENT_LIMIT; index 0 is the latest entry. */
  recent: DashboardRecentCandidate[];
}

export interface DashboardOptions {
  byAgentNames: string[];
  scope: DashboardScope;
  from?: number;
  to: number;
  agentInfoMap?: Map<string, AgentInfo>;
  /** Immediately preceding window of equal length; drives `totals.previous`. */
  compare?: { from: number; to: number };
}

// --- SessionHead domain helpers (shared with other handlers via re-export) ---

export function getTotalTokens(stats: SessionHead["stats"]): number {
  return stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
}

export function getSessionAgentName(session: SessionHead): string {
  return getSessionAgentKey(session);
}

export function getSessionActivityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

function matchesScope(session: SessionHead, scope: DashboardScope): boolean {
  if (scope.agent && getSessionAgentName(session) !== scope.agent) return false;
  if (scope.projectKind == null && scope.projectKey == null) return true;
  const identity = session.project_identity;
  // A half-specified scope matches nothing: identity fields are never undefined.
  return (
    identity != null && identity.kind === scope.projectKind && identity.key === scope.projectKey
  );
}

/** Top-level nodes (roots ∪ orphans) inside the window that match the scope. */
function scopedEntries(
  tree: SessionTree,
  scope: DashboardScope,
  from: number | undefined,
  to: number,
): SessionTreeNode[] {
  return filterSessionTreeEntriesByActivityWindow(tree, from, to).filter((node) =>
    matchesScope(node.session, scope),
  );
}

function emptyDailyBucket(date: string): DashboardDailyBucket {
  return {
    date,
    sessions: 0,
    messages: 0,
    cost: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
  };
}

function createAccumulator(
  byAgentNames: string[],
  scope: DashboardScope,
  to: number,
): DashboardAccumulator {
  const agents = new Map<string, DashboardAgentAggregate>();
  for (const name of byAgentNames) {
    const key = name.toLowerCase();
    if (scope.agent && key !== scope.agent) continue;
    agents.set(key, { name, sessions: 0, messages: 0, tokens: 0, cost: 0 });
  }

  const sparklineSlots = new Map<string, number>();
  for (let slot = 0; slot < PROJECT_SPARKLINE_DAYS; slot += 1) {
    const day = addCalendarDays(to, slot - (PROJECT_SPARKLINE_DAYS - 1));
    sparklineSlots.set(toCalendarDayKey(day), slot);
  }

  return {
    sessions: 0,
    messages: 0,
    tokens: 0,
    cost: 0,
    costRecorded: 0,
    costEstimated: 0,
    cacheReadTokens: 0,
    hasEstimatedCost: false,
    agents,
    agentKeys: new Set(),
    daily: new Map(),
    models: new Map(),
    projects: new Map(),
    sparklineSlots,
    recent: [],
  };
}

function foldModelUsage(node: SessionTreeNode, into: Map<string, number>): void {
  if (node.session.model_usage) {
    for (const [model, tokens] of Object.entries(node.session.model_usage)) {
      into.set(model, (into.get(model) ?? 0) + tokens);
    }
  }
  for (const child of node.children) foldModelUsage(child, into);
}

function trackProject(
  node: SessionTreeNode,
  acc: DashboardAccumulator,
  dayKey: string,
  agentKey: string,
): void {
  const identity = node.session.project_identity;
  if (!identity) return;

  const key = getProjectIdentityKey(identity);
  let project = acc.projects.get(key);
  if (!project) {
    project = {
      identityKind: identity.kind,
      identityKey: identity.key,
      displayName: identity.displayName,
      sessions: 0,
      messages: 0,
      tokens: 0,
      cost: 0,
      hasEstimatedCost: false,
      agentSessions: new Map(),
      sparkline: Array.from({ length: PROJECT_SPARKLINE_DAYS }, () => 0),
    };
    acc.projects.set(key, project);
  }

  const stats = node.inclusiveStats;
  project.sessions += 1;
  project.messages += stats.messageCount;
  project.tokens += stats.totalTokens;
  project.cost += stats.cost;
  if (stats.costSource === "estimated") project.hasEstimatedCost = true;
  project.agentSessions.set(agentKey, (project.agentSessions.get(agentKey) ?? 0) + 1);

  const slot = acc.sparklineSlots.get(dayKey);
  if (slot != null) project.sparkline[slot]! += stats.cost;
}

/** Fold one top-level node (and, via inclusiveStats, its whole subtree) into `acc`. */
function accumulate(node: SessionTreeNode, acc: DashboardAccumulator): void {
  const session = node.session;
  const stats = node.inclusiveStats;
  const activity = getSessionActivityTime(session);
  const agentKey = getSessionAgentName(session);

  acc.sessions += 1;
  acc.messages += stats.messageCount;
  acc.tokens += stats.totalTokens;
  acc.cost += stats.cost;
  acc.cacheReadTokens += stats.cacheReadTokens;
  acc.agentKeys.add(agentKey);
  // A subtree that reports no source is estimating: only pi/grok ever record.
  if (stats.costSource === "recorded") acc.costRecorded += stats.cost;
  else acc.costEstimated += stats.cost;
  if (stats.costSource === "estimated") acc.hasEstimatedCost = true;

  const metric = acc.agents.get(agentKey);
  if (metric) {
    metric.sessions += 1;
    metric.messages += stats.messageCount;
    metric.tokens += stats.totalTokens;
    metric.cost += stats.cost;
  }

  const dayKey = toCalendarDayKey(activity);
  let bucket = acc.daily.get(dayKey);
  if (!bucket) {
    bucket = emptyDailyBucket(dayKey);
    acc.daily.set(dayKey, bucket);
  }
  bucket.sessions += 1;
  bucket.messages += stats.messageCount;
  bucket.cost += stats.cost;
  bucket.input += Math.max(0, stats.inputTokens - stats.cacheReadTokens - stats.cacheCreateTokens);
  bucket.output += stats.outputTokens;
  bucket.cache_read += stats.cacheReadTokens;
  bucket.cache_create += stats.cacheCreateTokens;

  const usage = new Map<string, number>();
  foldModelUsage(node, usage);
  for (const [model, tokens] of usage) {
    const entry = acc.models.get(model);
    if (entry) {
      entry.tokens += tokens;
      entry.sessions += 1;
    } else {
      acc.models.set(model, { tokens, sessions: 1 });
    }
  }

  trackProject(node, acc, dayKey, agentKey);

  let recentIndex = acc.recent.length;
  for (let i = 0; i < acc.recent.length; i += 1) {
    if (activity > acc.recent[i]!.activity) {
      recentIndex = i;
      break;
    }
  }
  if (recentIndex < DASHBOARD_RECENT_LIMIT) {
    acc.recent.splice(recentIndex, 0, { session, activity });
    if (acc.recent.length > DASHBOARD_RECENT_LIMIT) acc.recent.pop();
  }
}

function toPreviousTotals(acc: DashboardAccumulator): DashboardPreviousTotals {
  return { sessions: acc.sessions, messages: acc.messages, tokens: acc.tokens, cost: acc.cost };
}

function toProjectStat(project: DashboardProjectAggregate): DashboardProjectStat {
  return {
    identityKind: project.identityKind,
    identityKey: project.identityKey,
    displayName: project.displayName,
    sessions: project.sessions,
    messages: project.messages,
    tokens: project.tokens,
    cost: project.cost,
    cost_source:
      project.cost > 0 ? (project.hasEstimatedCost ? "estimated" : "recorded") : undefined,
    agents: [...project.agentSessions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([agentKey]) => agentKey),
    sparkline: project.sparkline,
  };
}

/**
 * Aggregate sessions into dashboard metrics, daily buckets, model distribution,
 * project ranking and the recent-sessions window. Pure — no HTTP, no DB.
 */
export function buildDashboard(
  sessions: SessionHead[],
  options: DashboardOptions,
): DashboardAggregate {
  const { byAgentNames, scope, from, to, agentInfoMap, compare } = options;
  const tree = buildSessionTree(sessions);

  const acc = createAccumulator(byAgentNames, scope, to);
  if (from != null) {
    const bucketDays = countCalendarDays(from, to);
    for (let i = 0; i < bucketDays; i += 1) {
      const key = toCalendarDayKey(addCalendarDays(from, i));
      acc.daily.set(key, emptyDailyBucket(key));
    }
  }
  for (const node of scopedEntries(tree, scope, from, to)) accumulate(node, acc);

  let previous: DashboardPreviousTotals | undefined;
  if (compare) {
    const compareAcc = createAccumulator(byAgentNames, scope, compare.to);
    for (const node of scopedEntries(tree, scope, compare.from, compare.to)) {
      accumulate(node, compareAcc);
    }
    previous = toPreviousTotals(compareAcc);
  }

  const perAgent: DashboardAgentStat[] = [...acc.agents.values()]
    .map((metrics) => {
      const info = agentInfoMap?.get(metrics.name);
      return {
        name: metrics.name,
        displayName: info?.displayName ?? metrics.name,
        icon: info?.icon ?? "",
        iconColored: info?.iconColored,
        sessions: metrics.sessions,
        messages: metrics.messages,
        tokens: metrics.tokens,
        cost: metrics.cost,
      };
    })
    .filter((item) => item.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);

  const dailyActivity = [...acc.daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const modelDistribution: ModelDistributionEntry[] = [...acc.models.entries()]
    .map(([model, { tokens, sessions: count }]) => ({ model, tokens, sessions: count }))
    .sort((a, b) => b.tokens - a.tokens);

  const rankedProjects = [...acc.projects.values()].sort((a, b) => b.cost - a.cost);
  const perProject = rankedProjects.slice(0, DASHBOARD_PROJECT_LIMIT).map(toProjectStat);
  const projectRollup = rankedProjects
    .slice(DASHBOARD_PROJECT_LIMIT)
    .reduce<DashboardProjectRollup>(
      (rollup, project) => ({
        projects: rollup.projects + 1,
        sessions: rollup.sessions + project.sessions,
        tokens: rollup.tokens + project.tokens,
        cost: rollup.cost + project.cost,
      }),
      { projects: 0, sessions: 0, tokens: 0, cost: 0 },
    );

  const recentSessions: DashboardRecentSession[] = acc.recent.map(({ session }) => ({
    reference: { agentName: getSessionAgentName(session), sessionId: session.id },
    session,
  }));

  const latest = acc.recent[0];
  return {
    totals: {
      sessions: acc.sessions,
      messages: acc.messages,
      tokens: acc.tokens,
      cost: acc.cost,
      costRecorded: acc.costRecorded,
      costEstimated: acc.costEstimated,
      cacheReadTokens: acc.cacheReadTokens,
      cost_source: acc.cost > 0 ? (acc.hasEstimatedCost ? "estimated" : "recorded") : undefined,
      latestActivity: latest?.activity || undefined,
      latestActivityProject: latest?.session.project_identity?.displayName,
      latestActivityAgent: latest ? getSessionAgentName(latest.session) : undefined,
      previous,
    },
    scopeCounts: { projects: acc.projects.size, agents: acc.agentKeys.size },
    perAgent,
    dailyActivity,
    modelDistribution,
    perProject,
    projectRollup,
    recentSessions,
  };
}
