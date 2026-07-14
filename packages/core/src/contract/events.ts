import type { SessionHead } from "./session.js";

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
  changedSessionHeads: Array<{ agentName: string; session: SessionHead }>;
  removedSessionRefs: Array<{ agentName: string; sessionId: string }>;
}

export interface AgentScanStatus {
  agentName: string;
  status: "pending" | "scanning" | "complete";
  total?: number;
  processed?: number;
  sessions?: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Full-history reconciliation runs independently of the main scan phase:
 * startup only syncs the display window, so a low-priority background pass
 * (capped at one agent at a time) periodically re-checks the rest of history.
 */
export interface BackfillStatus {
  active: boolean;
  pendingAgents: string[];
  currentAgent?: string;
  completedAgents: string[];
  failedAgents: string[];
}

export interface ScanStatusEvent {
  type: "scan-status";
  active: boolean;
  phase: "idle" | "indexing" | "initializing" | "scanning";
  pendingAgents: string[];
  scanningAgents: string[];
  completedAgents: string[];
  agentStatuses: Record<string, AgentScanStatus>;
  totalAgents: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  backfill: BackfillStatus;
}
