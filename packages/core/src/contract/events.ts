import type { ReferencedSessionHead } from "./session.js";
import type { SessionReference } from "./session-reference.js";

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  /** Exact new-session subset for consumers that project the global event into a local view. */
  newSessionRefs?: SessionReference[];
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
  changedSessionHeads: ReferencedSessionHead[];
  /** Unchanged hierarchy context; it must not count as an update or invalidate session detail. */
  projectionRelatedSessionHeads?: ReferencedSessionHead[];
  /** Canonical global order for affected activity-time ties. */
  projectionSessionOrder?: SessionReference[];
  removedSessionRefs: SessionReference[];
}

export function mergeSessionsUpdatedEvents(
  previous: SessionsUpdatedEvent,
  next: SessionsUpdatedEvent,
): SessionsUpdatedEvent {
  const changedSessionHeads = new Map<string, ReferencedSessionHead>();
  const projectionRelatedSessionHeads = new Map<string, ReferencedSessionHead>();
  const projectionSessionOrder = new Map<string, SessionReference>();
  const newSessionRefs = new Map<string, SessionReference>();
  const removedSessionRefs = new Map<string, SessionReference>();
  const sessionKey = (agentName: string, sessionId: string) => `${agentName}\0${sessionId}`;
  const addChanged = (item: ReferencedSessionHead) => {
    const key = sessionKey(item.reference.agentName, item.reference.sessionId);
    removedSessionRefs.delete(key);
    projectionRelatedSessionHeads.delete(key);
    changedSessionHeads.set(key, item);
  };
  const addProjectionRelated = (item: ReferencedSessionHead) => {
    const key = sessionKey(item.reference.agentName, item.reference.sessionId);
    if (changedSessionHeads.has(key) || removedSessionRefs.has(key)) return;
    projectionRelatedSessionHeads.set(key, item);
  };
  const addNew = (item: SessionReference) => {
    const key = sessionKey(item.agentName, item.sessionId);
    removedSessionRefs.delete(key);
    newSessionRefs.set(key, item);
  };
  const addProjectionOrder = (item: SessionReference) => {
    const key = sessionKey(item.agentName, item.sessionId);
    projectionSessionOrder.delete(key);
    projectionSessionOrder.set(key, item);
  };
  const addRemoved = (item: SessionReference) => {
    const key = sessionKey(item.agentName, item.sessionId);
    changedSessionHeads.delete(key);
    projectionRelatedSessionHeads.delete(key);
    projectionSessionOrder.delete(key);
    newSessionRefs.delete(key);
    removedSessionRefs.set(key, item);
  };

  for (const item of previous.newSessionRefs ?? []) addNew(item);
  for (const item of previous.projectionRelatedSessionHeads ?? []) addProjectionRelated(item);
  for (const item of previous.projectionSessionOrder ?? []) addProjectionOrder(item);
  for (const item of previous.changedSessionHeads) addChanged(item);
  for (const item of previous.removedSessionRefs) addRemoved(item);
  for (const item of next.newSessionRefs ?? []) addNew(item);
  for (const item of next.projectionRelatedSessionHeads ?? []) addProjectionRelated(item);
  for (const item of next.projectionSessionOrder ?? []) addProjectionOrder(item);
  for (const item of next.changedSessionHeads) addChanged(item);
  for (const item of next.removedSessionRefs) addRemoved(item);

  return {
    type: "sessions-updated",
    changedAgents: Array.from(new Set([...previous.changedAgents, ...next.changedAgents])),
    newSessions: previous.newSessions + next.newSessions,
    newSessionRefs: [...newSessionRefs.values()],
    updatedSessions: previous.updatedSessions + next.updatedSessions,
    removedSessions: previous.removedSessions + next.removedSessions,
    totalSessions: next.totalSessions,
    timestamp: next.timestamp,
    changedSessionHeads: [...changedSessionHeads.values()],
    projectionRelatedSessionHeads: [...projectionRelatedSessionHeads.values()],
    projectionSessionOrder: [...projectionSessionOrder.values()],
    removedSessionRefs: [...removedSessionRefs.values()],
  };
}

export interface AgentScanStatus {
  agentName: string;
  status: "pending" | "scanning" | "finalizing" | "indexing" | "complete" | "failed";
  error?: string;
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
export interface BackfillProgress {
  phase?: "scanning" | "finalizing" | "indexing";
  total?: number;
  processed?: number;
  sessions?: number;
}

export interface BackfillStatus {
  active: boolean;
  pendingAgents: string[];
  currentAgent?: string;
  progress?: BackfillProgress;
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
