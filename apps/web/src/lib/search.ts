import { type SearchRequestOptions, type SearchResult } from "./api";
import { type SessionIndexes, getSessionAgentKey } from "./session-indexes";
import { getProjectIdentityKey } from "./projects";
import type { SearchFilterState } from "../components/app/types";

export function buildSearchRequestOptions(
  filters: SearchFilterState,
  costMin: number | undefined,
): SearchRequestOptions {
  return {
    agent: filters.agent,
    projectKind: filters.project?.kind,
    projectKey: filters.project?.key,
    tag: filters.tag,
    tool: filters.tool,
    fileKind: filters.fileKind,
    costMin,
  };
}

export function usesServerSearch(activeQuery: string, filters: SearchFilterState): boolean {
  return activeQuery.trim().length > 0 || Boolean(filters.tool || filters.fileKind);
}

export function buildLocalRecentResults(
  sessionIndexes: SessionIndexes,
  filters: SearchFilterState,
  costMin: number | undefined,
): SearchResult[] {
  const agentSessions = filters.agent ? (sessionIndexes.byAgent.get(filters.agent) ?? []) : null;
  const projectIdentityKey = filters.project ? getProjectIdentityKey(filters.project) : undefined;
  const projectSessions = projectIdentityKey
    ? (sessionIndexes.byProjectIdentityKey.get(projectIdentityKey) ?? [])
    : null;
  const sourceSessions =
    agentSessions && projectSessions
      ? agentSessions.length <= projectSessions.length
        ? agentSessions
        : projectSessions
      : (agentSessions ?? projectSessions ?? sessionIndexes.sessionsByActivity);
  const results: SearchResult[] = [];

  for (const sessionItem of sourceSessions) {
    if (filters.agent && getSessionAgentKey(sessionItem) !== filters.agent) continue;
    if (
      projectIdentityKey &&
      (!sessionItem.project_identity ||
        getProjectIdentityKey(sessionItem.project_identity) !== projectIdentityKey)
    ) {
      continue;
    }
    if (filters.tag && !sessionItem.smart_tags?.includes(filters.tag)) continue;
    if (costMin !== undefined && sessionItem.stats.total_cost < costMin) continue;

    results.push({
      agentName: getSessionAgentKey(sessionItem),
      session: sessionItem,
      snippet: `Recent session · ${sessionItem.directory}`,
      matchType: "recent" as const,
    });
    if (results.length >= 50) break;
  }

  return results;
}
