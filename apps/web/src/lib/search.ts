import { type SearchRequestOptions, type SearchResult } from "./api";
import { type SessionIndexes, getSessionAgentKey } from "./session-indexes";
import { getProjectIdentityKey } from "./projects";
import type { SearchFilterState, SearchProjectOption } from "../components/app/types";

interface SearchProjectOptionsInput {
  usesServerSearch: boolean;
  isLoading: boolean;
  results: SearchResult[];
  selectedProject: SearchFilterState["project"];
  recentProjectOptions: SearchProjectOption[];
}

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

export function buildSearchProjectOptions({
  usesServerSearch,
  isLoading,
  results,
  selectedProject,
  recentProjectOptions,
}: SearchProjectOptionsInput): SearchProjectOption[] {
  if (!usesServerSearch) return recentProjectOptions;

  const optionsByKey = new Map<string, SearchProjectOption>();
  const sourceResults = isLoading ? [] : results;
  for (const result of sourceResults) {
    const identity = result.session.project_identity;
    if (!identity?.key) continue;
    const key = getProjectIdentityKey(identity);
    const current = optionsByKey.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    optionsByKey.set(key, {
      key,
      identityKind: identity.kind,
      identityKey: identity.key,
      label: identity.displayName || result.session.directory,
      count: 1,
      showCount: false,
    });
  }

  const selectedKey = selectedProject ? getProjectIdentityKey(selectedProject) : undefined;
  const selectedOption = selectedKey
    ? recentProjectOptions.find((project) => project.key === selectedKey)
    : undefined;
  if (selectedKey && selectedOption && !optionsByKey.has(selectedKey)) {
    optionsByKey.set(selectedKey, { ...selectedOption, count: 0, showCount: false });
  }
  return [...optionsByKey.values()].toSorted((left, right) => right.count - left.count).slice(0, 8);
}
