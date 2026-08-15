import type { FileActivityResult } from "./file-activity.js";
import type { ModelCostEntry } from "./model-cost.js";
import type { ProjectIdentityKind } from "./project-identity.js";
import type { CostSource, ReferencedSessionHead } from "./session.js";

export interface DashboardAgentStat {
  name: string;
  displayName: string;
  icon: string;
  iconColored?: boolean;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

/** One bucket per calendar day. */
export interface DashboardDailyBucket {
  date: string;
  sessions: number;
  messages: number;
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface ModelDistributionEntry {
  model: string;
  tokens: number;
  sessions: number;
}

export interface DashboardProjectStat {
  identityKind: ProjectIdentityKind;
  identityKey: string;
  displayName: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  cost_source?: CostSource;
  /** Agent keys, desc by session count. */
  agents: string[];
  /** Fixed length PROJECT_SPARKLINE_DAYS, oldest→newest, daily cost. */
  sparkline: number[];
}

/** Everything past the DASHBOARD_PROJECT_LIMIT truncation of `perProject`. */
export interface DashboardProjectRollup {
  projects: number;
  sessions: number;
  tokens: number;
  cost: number;
}

export interface DashboardPreviousTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

export type DashboardRecentSession = ReferencedSessionHead;

export interface DashboardTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  costRecorded: number;
  costEstimated: number;
  cacheReadTokens: number;
  cost_source?: CostSource;
  latestActivity?: number;
  latestActivityProject?: string;
  latestActivityAgent?: string;
  /** Same metrics over the immediately preceding window of equal length. */
  previous?: DashboardPreviousTotals;
}

export interface DashboardAggregate {
  totals: DashboardTotals;
  scopeCounts: { projects: number; agents: number };
  perAgent: DashboardAgentStat[];
  dailyActivity: DashboardDailyBucket[];
  modelDistribution: ModelDistributionEntry[];
  /** null when message-level cost facts are unavailable. */
  modelCost: ModelCostEntry[] | null;
  perProject: DashboardProjectStat[];
  projectRollup: DashboardProjectRollup;
  recentSessions: DashboardRecentSession[];
}

export interface DashboardData extends DashboardAggregate {
  recentFileActivities: FileActivityResult[];
  window: { from?: number; to: number; days?: number; compareFrom?: number; compareTo?: number };
}
