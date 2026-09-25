import type { SessionsUpdatedEvent } from "./generated/SessionsUpdatedEvent.js";

export type { SessionsUpdatedEvent } from "./generated/SessionsUpdatedEvent.js";
export type { AgentScanStatus } from "./generated/AgentScanStatus.js";
export type { ScanCompletion } from "./generated/ScanCompletion.js";
export type { BackfillProgress } from "./generated/BackfillProgress.js";
export type { BackfillStatus } from "./generated/BackfillStatus.js";
export type { SearchIndexMaintenanceStatus } from "./generated/SearchIndexMaintenanceStatus.js";
export type { ScanStatusEvent } from "./generated/ScanStatusEvent.js";
import type { PublicReferencedSessionHead } from "./session.js";
import type { SessionReference } from "./session-reference.js";

export function mergeSessionsUpdatedEvents(
  previous: SessionsUpdatedEvent,
  next: SessionsUpdatedEvent,
): SessionsUpdatedEvent {
  const changedSessionHeads = new Map<string, PublicReferencedSessionHead>();
  const projectionRelatedSessionHeads = new Map<string, PublicReferencedSessionHead>();
  const projectionSessionOrder = new Map<string, SessionReference>();
  const newSessionRefs = new Map<string, SessionReference>();
  const removedSessionRefs = new Map<string, SessionReference>();
  const sessionKey = (agentName: string, sessionId: string) => `${agentName}\0${sessionId}`;
  const addChanged = (item: PublicReferencedSessionHead) => {
    const key = sessionKey(item.reference.agentName, item.reference.sessionId);
    removedSessionRefs.delete(key);
    projectionRelatedSessionHeads.delete(key);
    changedSessionHeads.set(key, item);
  };
  const addProjectionRelated = (item: PublicReferencedSessionHead) => {
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

  for (const item of previous.newSessionRefs) addNew(item);
  for (const item of previous.projectionRelatedSessionHeads ?? []) addProjectionRelated(item);
  for (const item of previous.projectionSessionOrder ?? []) addProjectionOrder(item);
  for (const item of previous.changedSessionHeads) addChanged(item);
  for (const item of previous.removedSessionRefs) addRemoved(item);
  for (const item of next.newSessionRefs) addNew(item);
  for (const item of next.projectionRelatedSessionHeads ?? []) addProjectionRelated(item);
  for (const item of next.projectionSessionOrder ?? []) addProjectionOrder(item);
  for (const item of next.changedSessionHeads) addChanged(item);
  for (const item of next.removedSessionRefs) addRemoved(item);

  return {
    type: "sessions-updated",
    changedAgents: Array.from(new Set([...previous.changedAgents, ...next.changedAgents])),
    newSessionRefs: [...newSessionRefs.values()],
    totalSessions: next.totalSessions,
    timestamp: next.timestamp,
    changedSessionHeads: [...changedSessionHeads.values()],
    projectionRelatedSessionHeads: [...projectionRelatedSessionHeads.values()],
    projectionSessionOrder: [...projectionSessionOrder.values()],
    removedSessionRefs: [...removedSessionRefs.values()],
  };
}
