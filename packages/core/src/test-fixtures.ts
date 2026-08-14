import type { DashboardData } from "./contract/dashboard.js";
import type { AgentScanStatus, ScanStatusEvent, SessionsUpdatedEvent } from "./contract/events.js";
import type { SessionHead } from "./contract/session.js";

export const SAMPLE_SESSION_HEAD = {
  id: "session-1",
  slug: "claudecode/session-1",
  title: "Fix flaky search index test",
  directory: "/Users/dev/project",
  project_identity: {
    kind: "git_remote",
    key: "github.com/example/project",
    displayName: "example/project",
  },
  time_created: 1_700_000_000_000,
  time_updated: 1_700_003_600_000,
  stats: {
    message_count: 12,
    total_input_tokens: 4200,
    total_output_tokens: 1800,
    total_cost: 0.042,
    cost_source: "recorded",
    total_tokens: 6000,
    total_cache_read_tokens: 3000,
    total_cache_create_tokens: 500,
  },
  model_usage: { "claude-5-sonnet": 6000 },
  smart_tags: ["bugfix"],
  smart_tags_source_updated_at: 1_700_003_600_000,
} satisfies SessionHead;

const SAMPLE_AGENT_SCAN_STATUS = {
  agentName: "claudecode",
  status: "complete",
  total: 42,
  processed: 42,
  sessions: 42,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
  completedAt: 1_700_000_010_000,
} satisfies AgentScanStatus;

export const SAMPLE_SCAN_STATUS_EVENT = {
  type: "scan-status",
  active: false,
  phase: "idle",
  pendingAgents: [],
  scanningAgents: [],
  completedAgents: ["claudecode"],
  agentStatuses: { claudecode: SAMPLE_AGENT_SCAN_STATUS },
  totalAgents: 1,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
  completedAt: 1_700_000_010_000,
  backfill: {
    active: false,
    pendingAgents: [],
    completedAgents: ["claudecode"],
    failedAgents: [],
  },
  searchIndexMaintenance: {
    active: false,
    pendingAgents: [],
    completedAgents: [],
    failedAgents: [],
  },
} satisfies ScanStatusEvent;

export const SAMPLE_SESSIONS_UPDATED_EVENT = {
  type: "sessions-updated",
  changedAgents: ["claudecode"],
  newSessions: 1,
  newSessionRefs: [{ agentName: "claudecode", sessionId: SAMPLE_SESSION_HEAD.id }],
  updatedSessions: 0,
  removedSessions: 0,
  totalSessions: 43,
  timestamp: 1_700_000_020_000,
  changedSessionHeads: [
    {
      reference: { agentName: "claudecode", sessionId: SAMPLE_SESSION_HEAD.id },
      session: SAMPLE_SESSION_HEAD,
    },
  ],
  projectionRelatedSessionHeads: [],
  projectionSessionOrder: [{ agentName: "claudecode", sessionId: SAMPLE_SESSION_HEAD.id }],
  removedSessionRefs: [],
} satisfies SessionsUpdatedEvent;

export const SAMPLE_DASHBOARD_DATA = {
  totals: {
    sessions: 1,
    messages: 12,
    tokens: 6000,
    cost: 0.042,
    costRecorded: 0.042,
    costEstimated: 0,
    cacheReadTokens: 3000,
    cost_source: "recorded",
    latestActivity: 1_700_003_600_000,
    latestActivityProject: "example/project",
    latestActivityAgent: "claudecode",
  },
  scopeCounts: { projects: 1, agents: 1 },
  perAgent: [
    {
      name: "claudecode",
      displayName: "Claude Code",
      icon: "claude",
      sessions: 1,
      messages: 12,
      tokens: 6000,
      cost: 0.042,
    },
  ],
  dailyActivity: [
    {
      date: "2023-11-14",
      sessions: 1,
      messages: 12,
      cost: 0.042,
      input: 700,
      output: 1800,
      cache_read: 3000,
      cache_create: 500,
    },
  ],
  modelDistribution: [{ model: "claude-5-sonnet", tokens: 6000, sessions: 1 }],
  perProject: [
    {
      identityKind: "git_remote",
      identityKey: "github.com/example/project",
      displayName: "example/project",
      sessions: 1,
      messages: 12,
      tokens: 6000,
      cost: 0.042,
      cost_source: "recorded",
      agents: ["claudecode"],
      sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.042],
    },
  ],
  projectRollup: { projects: 0, sessions: 0, tokens: 0, cost: 0 },
  recentSessions: [
    {
      reference: { agentName: "claudecode", sessionId: SAMPLE_SESSION_HEAD.id },
      session: SAMPLE_SESSION_HEAD,
    },
  ],
  recentFileActivities: [],
  modelCost: null,
  window: { from: 1_699_900_000_000, to: 1_700_003_600_000, days: 1 },
} satisfies DashboardData;
