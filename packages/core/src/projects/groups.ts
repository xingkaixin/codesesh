import type { ProjectGroup, ProjectIdentity, SessionHead } from "../types/index.js";
import { getProjectIdentityKey } from "./identity.js";

function getAgentName(session: SessionHead): string {
  return session.slug.split("/")[0]?.toLowerCase() || "unknown";
}

export function buildProjectGroups(sessions: SessionHead[]): ProjectGroup[] {
  const groups = new Map<
    string,
    { identity: ProjectIdentity; sources: Set<string>; sessionCount: number; lastActivity: number }
  >();

  for (const session of sessions) {
    const identity = session.project_identity;
    if (!identity) continue;
    const activity = session.time_updated ?? session.time_created;
    const groupKey = getProjectIdentityKey(identity);
    const current = groups.get(groupKey);
    if (current) {
      current.sources.add(getAgentName(session));
      current.sessionCount += 1;
      current.lastActivity = Math.max(current.lastActivity, activity);
    } else {
      groups.set(groupKey, {
        identity,
        sources: new Set([getAgentName(session)]),
        sessionCount: 1,
        lastActivity: activity,
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      identityKind: group.identity.kind,
      identityKey: group.identity.key,
      displayName: group.identity.displayName,
      sources: [...group.sources].sort(),
      sessionCount: group.sessionCount,
      lastActivity: group.lastActivity || null,
    }))
    .sort((a, b) => {
      if (a.identityKind === "loose" && b.identityKind !== "loose") return 1;
      if (b.identityKind === "loose" && a.identityKind !== "loose") return -1;
      return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
    });
}
