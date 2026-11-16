import {
  agentRoutePath,
  createSessionIndex,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionReferenceKey as referenceKey,
  getSessionRoutePath,
  getSessionRouteKey,
  sessionRoutePath,
  type AgentInfo,
  type ApiProjectGroup,
  type ProjectIdentityKind,
  type SessionHead,
} from "@codesesh/contract";
import {
  buildProjectDisplayNameMap,
  getProjectIdentityKey,
  isGitRemoteFallbackDisplayName,
  resolveProjectDisplayName,
} from "./projects";

export type IndexedSession = SessionHead;

export interface SessionProjectOption {
  key: string;
  identityKind: ProjectIdentityKind;
  identityKey: string;
  label: string;
  count: number;
}

export interface SessionIndexes {
  byRouteKey: Map<string, SessionHead>;
  childrenByParentRouteKey: Map<string, SessionHead[]>;
  byAgent: Map<string, SessionHead[]>;
  byProjectIdentityKey: Map<string, SessionHead[]>;
  byProjectAgentKey: Map<string, SessionHead[]>;
  byLandingAgent: Map<string, IndexedSession[]>;
  byLandingProjectIdentityKey: Map<string, IndexedSession[]>;
  landingSessions: IndexedSession[];
  sessionsByActivity: SessionHead[];
  projectOptions: SessionProjectOption[];
  projectDisplayNames: ReadonlyMap<string, string>;
}

export interface SidebarSessionLookup {
  byReference: Map<string, SessionHead>;
  indexByReference: Map<string, number>;
}

export {
  agentRoutePath,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionRoutePath,
  getSessionRouteKey,
  sessionRoutePath,
};

export function getSessionReferenceKey(session: Pick<SessionHead, "reference">): string {
  return referenceKey(session.reference);
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const current = map.get(key);
  if (current) {
    current.push(value);
    return;
  }
  map.set(key, [value]);
}

export function buildSessionIndexes(
  sessions: SessionHead[],
  agents: AgentInfo[],
  projects: readonly Pick<ApiProjectGroup, "identityKind" | "identityKey" | "displayName">[] = [],
): SessionIndexes {
  const canonical = createSessionIndex(sessions);
  const projectDisplayNames = buildProjectDisplayNameMap(projects);
  const byAgent = new Map<string, SessionHead[]>();
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
    landingSessions.push(session);
    if (knownAgentKeys.has(agentKey)) {
      byLandingAgent.get(agentKey)!.push(session);
    }

    const identity = session.project_identity;
    if (!identity?.key) continue;

    const projectIdentityKey = getProjectIdentityKey(identity);
    pushMapValue(byLandingProjectIdentityKey, projectIdentityKey, session);

    const option = projectOptionsByKey.get(projectIdentityKey);
    if (option) {
      option.count += 1;
      if (
        !projectDisplayNames.has(projectIdentityKey) &&
        identity.displayName &&
        isGitRemoteFallbackDisplayName({
          kind: identity.kind,
          key: identity.key,
          displayName: option.label,
        }) &&
        !isGitRemoteFallbackDisplayName(identity)
      ) {
        option.label = identity.displayName;
      }
    } else {
      projectOptionsByKey.set(projectIdentityKey, {
        key: projectIdentityKey,
        identityKind: identity.kind,
        identityKey: identity.key,
        label: resolveProjectDisplayName(identity, projectDisplayNames) || session.directory,
        count: 1,
      });
    }
  }

  for (const agentKey of knownAgentKeys) {
    byAgent.set(agentKey, canonical.byAgent.get(agentKey) ?? []);
  }

  return {
    byRouteKey: canonical.byRouteKey,
    childrenByParentRouteKey: canonical.childrenByParentRouteKey,
    byAgent,
    byProjectIdentityKey: canonical.byProjectIdentityKey,
    byProjectAgentKey: canonical.byProjectAgentKey,
    byLandingAgent,
    byLandingProjectIdentityKey,
    landingSessions,
    sessionsByActivity: canonical.sessionsByActivity,
    projectOptions: [...projectOptionsByKey.values()]
      .toSorted((a, b) => b.count - a.count)
      .slice(0, 8),
    projectDisplayNames,
  };
}

export function buildSidebarSessionLookup(sessions: SessionHead[]): SidebarSessionLookup {
  const byReference = new Map<string, SessionHead>();
  const indexByReference = new Map<string, number>();

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]!;
    const reference = getSessionReferenceKey(session);
    if (byReference.has(reference)) continue;
    byReference.set(reference, session);
    indexByReference.set(reference, index);
  }

  return { byReference, indexByReference };
}
