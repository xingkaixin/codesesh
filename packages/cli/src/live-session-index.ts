import {
  computeSessionDiff,
  mergeSortedSessions,
  sessionSignature,
  sortSessions,
  type AgentScanFailure,
  type BaseAgent,
  type LiveSnapshot,
  type SessionHead,
} from "@codesesh/core";
import type { SessionsUpdatedEvent } from "@codesesh/core/contract";

export interface LiveSessionIndexOptions {
  registeredAgents?: BaseAgent[];
  allowedAgents?: ReadonlySet<string> | null;
}

export class LiveSessionIndex {
  private agents: BaseAgent[] = [];
  private agentsByName = new Map<string, BaseAgent>();
  private byAgent: Record<string, SessionHead[]> = {};
  private sessions: SessionHead[] = [];
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
    this.scanFailures = { ...snapshot.scanFailures };
    this.byAgent = Object.fromEntries(
      this.agents.flatMap((agent) => {
        if (this.scanFailures[agent.name] && !(agent.name in snapshot.byAgent)) return [];
        return [[agent.name, sortSessions(snapshot.byAgent[agent.name] ?? [])]];
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
      ...(Object.keys(this.scanFailures).length > 0 ? { scanFailures: this.scanFailures } : {}),
    };
  }

  findAgent(agentName: string): BaseAgent | undefined {
    return this.agentsByName.get(agentName);
  }

  commitAgentSessions(
    agentName: string,
    nextSessions: SessionHead[],
    candidateChangedIds: string[] = [],
  ): SessionsUpdatedEvent | null {
    delete this.scanFailures[agentName];
    const previousSessions = this.byAgent[agentName] ?? [];
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

    return {
      type: "sessions-updated",
      changedAgents: [agentName],
      newSessions: counts.new,
      updatedSessions: counts.updated,
      removedSessions: counts.removed,
      totalSessions: this.sessions.length,
      timestamp: Date.now(),
      changedSessionHeads: changes.map(({ session }) => ({
        reference: { agentName, sessionId: session.id },
        session,
      })),
      removedSessionRefs: removedSessionIds.map((sessionId) => ({ agentName, sessionId })),
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
