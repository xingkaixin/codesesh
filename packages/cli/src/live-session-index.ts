import {
  computeSessionDiff,
  mergeSortedSessions,
  sessionSignature,
  type AgentCacheFailure,
  sortSessions,
  type IdentifiedSessionHead,
  type LiveSnapshot,
} from "@codesesh/core/runtime/discovery";
import { type AgentScanFailure, type BaseAgent } from "@codesesh/core/runtime/agents";
import {
  assertIdentifiedSessionHead,
  assertSessionIdentity,
  createSessionProjectionContext,
  toPublicReferencedSessionHead,
  type SessionsUpdatedEvent,
} from "@codesesh/core/contract";

export interface LiveSessionIndexOptions {
  registeredAgents?: BaseAgent[];
  allowedAgents?: ReadonlySet<string> | null;
}

export class LiveSessionIndex {
  private agents: BaseAgent[] = [];
  private agentsByName = new Map<string, BaseAgent>();
  private byAgent: Record<string, IdentifiedSessionHead[]> = {};
  private sessions: IdentifiedSessionHead[] = [];
  private cacheFailures: Record<string, AgentCacheFailure> = {};
  private scanFailures: Record<string, AgentScanFailure> = {};
  private signatureCaches = new Map<string, Map<string, string>>();

  initialize(snapshot: LiveSnapshot, options: LiveSessionIndexOptions = {}): void {
    const agentMap = new Map<string, BaseAgent>();
    for (const agent of snapshot.agents) agentMap.set(agent.name, agent);
    for (const agent of options.registeredAgents ?? []) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }

    this.agents = [...agentMap.values()].filter(
      (agent) => !options.allowedAgents || options.allowedAgents.has(agent.name.toLowerCase()),
    );
    this.agentsByName = new Map(this.agents.map((agent) => [agent.name, agent]));
    this.cacheFailures = { ...snapshot.cacheFailures };
    this.scanFailures = { ...snapshot.scanFailures };
    this.byAgent = Object.fromEntries(
      this.agents.flatMap((agent) => {
        if (this.scanFailures[agent.name] && !(agent.name in snapshot.byAgent)) return [];
        const sessions = snapshot.byAgent[agent.name] ?? [];
        for (const session of sessions) {
          assertSessionIdentity(session, agent.name);
          assertIdentifiedSessionHead(session);
        }
        return [[agent.name, sortSessions(sessions)]];
      }),
    );
    this.sessions = mergeSortedSessions(Object.values(this.byAgent));
    this.signatureCaches.clear();
  }

  snapshot(): LiveSnapshot {
    return {
      agents: this.agents,
      byAgent: this.byAgent,
      sessions: this.sessions,
      ...(Object.keys(this.cacheFailures).length > 0 ? { cacheFailures: this.cacheFailures } : {}),
      ...(Object.keys(this.scanFailures).length > 0 ? { scanFailures: this.scanFailures } : {}),
    };
  }

  findAgent(agentName: string): BaseAgent | undefined {
    return this.agentsByName.get(agentName);
  }

  commitAgentSessions(
    agentName: string,
    nextSessions: IdentifiedSessionHead[],
    candidateChangedIds: string[] = [],
  ): SessionsUpdatedEvent | null {
    for (const session of nextSessions) {
      assertSessionIdentity(session, agentName);
      assertIdentifiedSessionHead(session);
    }
    delete this.cacheFailures[agentName];
    delete this.scanFailures[agentName];
    const previousSessions = this.byAgent[agentName] ?? [];
    const previousGlobalSessions = this.sessions;
    const signatureCache = this.signatureCache(agentName);
    const { changes, removedSessionIds, counts } = computeSessionDiff(
      previousSessions,
      nextSessions,
      candidateChangedIds,
      sessionSignature,
      signatureCache,
    );
    for (const removedId of removedSessionIds) signatureCache.delete(removedId);

    this.byAgent[agentName] = sortSessions(nextSessions);
    this.sessions = mergeSortedSessions(Object.values(this.byAgent));
    if (counts.new === 0 && counts.updated === 0 && counts.removed === 0) return null;

    const changedSessionHeads = changes.map(({ session }) => ({
      reference: session.reference,
      session,
    }));
    const previousSessionIds = new Set(
      previousSessions.map((session) => session.reference.sessionId),
    );
    const newSessionRefs = changedSessionHeads.flatMap(({ reference }) =>
      previousSessionIds.has(reference.sessionId) ? [] : [reference],
    );
    const removedSessionRefs = removedSessionIds.map((sessionId) => ({ agentName, sessionId }));
    const projectionContext = createSessionProjectionContext(
      previousGlobalSessions,
      this.sessions,
      changedSessionHeads,
      removedSessionRefs,
    );
    return {
      type: "sessions-updated",
      changedAgents: [agentName],
      newSessionRefs,
      totalSessions: this.sessions.length,
      timestamp: Date.now(),
      changedSessionHeads: changedSessionHeads.map(toPublicReferencedSessionHead),
      projectionRelatedSessionHeads: projectionContext.relatedSessionHeads.map(
        toPublicReferencedSessionHead,
      ),
      projectionSessionOrder: projectionContext.sessionOrder,
      removedSessionRefs,
    };
  }

  private signatureCache(agentName: string): Map<string, string> {
    const existing = this.signatureCaches.get(agentName);
    if (existing) return existing;
    const cache = new Map<string, string>();
    this.signatureCaches.set(agentName, cache);
    return cache;
  }
}
