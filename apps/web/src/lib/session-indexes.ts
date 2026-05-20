import type { AgentInfo, SessionHead } from "./api";
import { getProjectIdentityKey } from "./projects";

export interface IndexedSession extends SessionHead {
  agentKey: string;
  sessionSlug: string;
  fullPath: string;
}

export interface SessionProjectOption {
  key: string;
  label: string;
  count: number;
}

export interface SessionIndexes {
  byRouteKey: Map<string, SessionHead>;
  byAgent: Map<string, SessionHead[]>;
  byProjectIdentityKey: Map<string, SessionHead[]>;
  byProjectAgentKey: Map<string, SessionHead[]>;
  byProjectKey: Map<string, SessionHead[]>;
  byLandingAgent: Map<string, IndexedSession[]>;
  byLandingProjectIdentityKey: Map<string, IndexedSession[]>;
  landingSessions: IndexedSession[];
  sessionsByActivity: SessionHead[];
  projectOptions: SessionProjectOption[];
}

export interface SidebarSessionLookup {
  byId: Map<string, SessionHead>;
  indexById: Map<string, number>;
}

function compareSessionActivityDesc(a: SessionHead, b: SessionHead): number {
  return (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created);
}

export function getSessionAgentKey(session: Pick<SessionHead, "slug">): string {
  return session.slug.split("/")[0]?.toLowerCase() || "unknown";
}

export function getSessionRouteKey(agentKey: string, sessionId: string): string {
  return `${agentKey.toLowerCase()}/${sessionId}`;
}

export function getProjectAgentKey(projectIdentityKey: string, agentKey: string): string {
  return `${projectIdentityKey}\0${agentKey.toLowerCase()}`;
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const current = map.get(key);
  if (current) {
    current.push(value);
    return;
  }
  map.set(key, [value]);
}

export function buildSessionIndexes(sessions: SessionHead[], agents: AgentInfo[]): SessionIndexes {
  const byRouteKey = new Map<string, SessionHead>();
  const byAgent = new Map<string, SessionHead[]>();
  const byProjectIdentityKey = new Map<string, SessionHead[]>();
  const byProjectAgentKey = new Map<string, SessionHead[]>();
  const byProjectKey = new Map<string, SessionHead[]>();
  const byLandingAgent = new Map<string, IndexedSession[]>();
  const byLandingProjectIdentityKey = new Map<string, IndexedSession[]>();
  const projectOptionsByKey = new Map<string, SessionProjectOption>();
  const landingSessions: IndexedSession[] = [];
  const knownAgentKeys = new Set(agents.map((agent) => agent.name.toLowerCase()));

  for (const agentKey of knownAgentKeys) {
    byAgent.set(agentKey, []);
    byLandingAgent.set(agentKey, []);
  }

  for (const session of sessions) {
    const agentKey = getSessionAgentKey(session);
    const indexedSession: IndexedSession = {
      ...session,
      agentKey,
      sessionSlug: session.id,
      fullPath: session.slug,
    };

    landingSessions.push(indexedSession);
    const routeKey = getSessionRouteKey(agentKey, session.id);
    if (!byRouteKey.has(routeKey)) byRouteKey.set(routeKey, session);

    if (knownAgentKeys.has(agentKey)) {
      byLandingAgent.get(agentKey)!.push(indexedSession);
    }

    const identity = session.project_identity;
    if (!identity?.key) continue;

    const projectIdentityKey = getProjectIdentityKey(identity);
    pushMapValue(byLandingProjectIdentityKey, projectIdentityKey, indexedSession);

    const option = projectOptionsByKey.get(identity.key);
    if (option) {
      option.count += 1;
    } else {
      projectOptionsByKey.set(identity.key, {
        key: identity.key,
        label: identity.displayName || session.directory,
        count: 1,
      });
    }
  }

  const sessionsByActivity = sessions.toSorted(compareSessionActivityDesc);
  for (const session of sessionsByActivity) {
    const agentKey = getSessionAgentKey(session);
    if (knownAgentKeys.has(agentKey)) byAgent.get(agentKey)!.push(session);

    const identity = session.project_identity;
    if (!identity?.key) continue;

    const projectIdentityKey = getProjectIdentityKey(identity);
    pushMapValue(byProjectIdentityKey, projectIdentityKey, session);
    pushMapValue(byProjectAgentKey, getProjectAgentKey(projectIdentityKey, agentKey), session);
    pushMapValue(byProjectKey, identity.key, session);
  }

  return {
    byRouteKey,
    byAgent,
    byProjectIdentityKey,
    byProjectAgentKey,
    byProjectKey,
    byLandingAgent,
    byLandingProjectIdentityKey,
    landingSessions,
    sessionsByActivity,
    projectOptions: [...projectOptionsByKey.values()]
      .toSorted((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}

export function buildSidebarSessionLookup(sessions: SessionHead[]): SidebarSessionLookup {
  const byId = new Map<string, SessionHead>();
  const indexById = new Map<string, number>();

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]!;
    if (byId.has(session.id)) continue;
    byId.set(session.id, session);
    indexById.set(session.id, index);
  }

  return { byId, indexById };
}
