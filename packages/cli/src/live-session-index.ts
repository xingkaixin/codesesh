import {
  computeSessionDiff,
  mergeSortedSessions,
  matchesSessionQueryScope,
  sessionSignature,
  type AgentCacheFailure,
  sortSessions,
  type IdentifiedSessionHead,
  type LiveSnapshot,
  type SessionQueryScope,
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
  queryScope?: SessionQueryScope;
}

export class LiveSessionIndex {
  private agents: BaseAgent[] = [];
  private agentsByName = new Map<string, BaseAgent>();
  private queryScope?: SessionQueryScope;
  private allByAgent: Record<string, IdentifiedSessionHead[]> = {};
  private byAgent: Record<string, IdentifiedSessionHead[]> = {};
  private sessions: IdentifiedSessionHead[] = [];
  private cacheFailures: Record<string, AgentCacheFailure> = {};
  private scanFailures: Record<string, AgentScanFailure> = {};
  private signatureCaches = new Map<string, Map<string, string>>();

  initialize(snapshot: LiveSnapshot, options: LiveSessionIndexOptions = {}): void {
    this.queryScope = options.queryScope;
    const agentMap = new Map<string, BaseAgent>();
    for (const agent of snapshot.agents) agentMap.set(agent.name, agent);
    for (const agent of options.registeredAgents ?? []) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }

    this.agents = [...agentMap.values()].filter(
      (agent) =>
        !this.queryScope?.agents?.length ||
        this.queryScope.agents.includes(agent.name.toLowerCase()),
    );
    this.agentsByName = new Map(this.agents.map((agent) => [agent.name, agent]));
    this.cacheFailures = { ...snapshot.cacheFailures };
    this.scanFailures = { ...snapshot.scanFailures };
    this.allByAgent = {};
    this.byAgent = Object.fromEntries(
      this.agents.flatMap((agent) => {
        if (this.scanFailures[agent.name] && !(agent.name in snapshot.byAgent)) return [];
        const sessions = snapshot.byAgent[agent.name] ?? [];
        for (const session of sessions) {
          assertSessionIdentity(session, agent.name);
          assertIdentifiedSessionHead(session);
        }
        this.allByAgent[agent.name] = sortSessions(sessions);
        return [[agent.name, this.visibleSessions(this.allByAgent[agent.name]!)]];
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

  agentSessions(agentName: string): IdentifiedSessionHead[] {
    return this.allByAgent[agentName] ?? [];
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
    const visibleSessions = this.visibleSessions(nextSessions);
    delete this.cacheFailures[agentName];
    delete this.scanFailures[agentName];
    const previousSessions = this.byAgent[agentName] ?? [];
    const previousGlobalSessions = this.sessions;
    const signatureCache = this.signatureCache(agentName);
    const { changes, removedSessionIds, counts } = computeSessionDiff(
      previousSessions,
      visibleSessions,
      candidateChangedIds,
      sessionSignature,
      signatureCache,
    );
    for (const removedId of removedSessionIds) signatureCache.delete(removedId);

    this.allByAgent[agentName] = sortSessions(nextSessions);
    const hasChanges = counts.new > 0 || counts.updated > 0 || counts.removed > 0;
    if (!hasChanges && agentName in this.byAgent) return null;
    this.byAgent[agentName] = this.visibleSessions(this.allByAgent[agentName]!);
    this.sessions = mergeSortedSessions(Object.values(this.byAgent));
    if (!hasChanges) return null;

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

  private visibleSessions(sessions: IdentifiedSessionHead[]): IdentifiedSessionHead[] {
    if (!this.queryScope?.projectScope) return sessions;
    return sessions.filter((session) => matchesSessionQueryScope(session, this.queryScope));
  }
}
