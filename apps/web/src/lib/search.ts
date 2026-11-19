import { t } from "../i18n/translate";
import {
  buildSessionTree,
  isProjectIdentityKind,
  isSmartTag,
  sessionRoutePath,
  type FileActivityKind,
  type SearchResult,
} from "@codesesh/contract";
import type { SearchRequestOptions } from "./api";
import { type SessionIndexes, getSessionAgentKey, getSessionRouteKey } from "./session-indexes";
import {
  getProjectIdentityKey,
  isGitRemoteFallbackDisplayName,
  resolveProjectDisplayName,
} from "./projects";
import type { CostRangeId, SearchFilterState, SearchProjectOption } from "../components/app/types";

export const SEARCH_RESULT_LIMIT = 50;

export const COST_RANGE_OPTIONS: Array<{
  id: CostRangeId;
  label: string;
  costMin: number;
}> = [
  { id: "paid", label: "Cost > $0", costMin: 0.000001 },
  { id: "one_plus", label: "Cost >= $1", costMin: 1 },
  { id: "ten_plus", label: "Cost >= $10", costMin: 10 },
];

const FILE_ACTIVITY_KINDS = new Set<FileActivityKind>(["read", "edit", "write", "delete"]);
const COST_RANGE_IDS = new Set<CostRangeId>(COST_RANGE_OPTIONS.map((option) => option.id));

const SEARCH_URL_PARAM_KEYS = [
  "search",
  "q",
  "source",
  "agent",
  "projectKind",
  "projectKey",
  "tag",
  "tool",
  "fileKind",
  "cost",
] as const;

export interface SearchUrlState {
  active: boolean;
  query: string;
  filters: SearchFilterState;
}

function parseFileActivityKind(value: string | null): FileActivityKind | undefined {
  if (!value) return undefined;
  for (const kind of FILE_ACTIVITY_KINDS) {
    if (kind === value) return kind;
  }
  return undefined;
}

function parseCostRangeId(value: string | null): CostRangeId | undefined {
  if (!value) return undefined;
  for (const id of COST_RANGE_IDS) {
    if (id === value) return id;
  }
  return undefined;
}

export function readSearchUrlState(params: URLSearchParams): SearchUrlState {
  const query = (params.get("q") ?? "").trim();
  const sourceNodeId = params.get("source")?.trim() || undefined;
  const agent = params.get("agent")?.trim() || undefined;
  const rawProjectKind = params.get("projectKind")?.trim() ?? "";
  const rawProjectKey = params.get("projectKey")?.trim() ?? "";
  const project =
    rawProjectKey && isProjectIdentityKind(rawProjectKind)
      ? { kind: rawProjectKind, key: rawProjectKey }
      : undefined;
  const rawTag = params.get("tag")?.trim() ?? "";
  const tag = isSmartTag(rawTag) ? rawTag : undefined;
  const tool = params.get("tool")?.trim() || undefined;
  const fileKind = parseFileActivityKind(params.get("fileKind")?.trim() ?? null);
  const costRange = parseCostRangeId(params.get("cost")?.trim() ?? null);

  const filters: SearchFilterState = {};
  if (sourceNodeId) filters.sourceNodeId = sourceNodeId;
  if (agent) filters.agent = agent;
  if (project) filters.project = project;
  if (tag) filters.tag = tag;
  if (tool) filters.tool = tool;
  if (fileKind) filters.fileKind = fileKind;
  if (costRange) filters.costRange = costRange;

  const hasFilters = Object.keys(filters).length > 0;
  const active = params.has("search") || query.length > 0 || hasFilters;
  return { active, query, filters };
}

export function writeSearchUrlState(
  currentParams: URLSearchParams,
  state: SearchUrlState,
): URLSearchParams {
  const next = new URLSearchParams(currentParams);
  for (const key of SEARCH_URL_PARAM_KEYS) {
    next.delete(key);
  }
  if (!state.active) return next;

  const trimmedQuery = state.query.trim();
  let wroteSearchParam = false;
  if (trimmedQuery) {
    next.set("q", trimmedQuery);
    wroteSearchParam = true;
  }
  if (state.filters.sourceNodeId) {
    next.set("source", state.filters.sourceNodeId);
    wroteSearchParam = true;
  }
  if (state.filters.agent) {
    next.set("agent", state.filters.agent);
    wroteSearchParam = true;
  }
  if (state.filters.project) {
    next.set("projectKind", state.filters.project.kind);
    next.set("projectKey", state.filters.project.key);
    wroteSearchParam = true;
  }
  if (state.filters.tag) {
    next.set("tag", state.filters.tag);
    wroteSearchParam = true;
  }
  if (state.filters.tool) {
    next.set("tool", state.filters.tool);
    wroteSearchParam = true;
  }
  if (state.filters.fileKind) {
    next.set("fileKind", state.filters.fileKind);
    wroteSearchParam = true;
  }
  if (state.filters.costRange) {
    next.set("cost", state.filters.costRange);
    wroteSearchParam = true;
  }
  if (!wroteSearchParam) {
    next.set("search", "1");
  }
  return next;
}

export function searchResultPath(result: SearchResult): string {
  return (
    sessionRoutePath(result.reference) +
    (result.messageIndex == null ? "" : `#message-${result.messageIndex}`)
  );
}

interface SearchProjectOptionsInput {
  usesServerSearch: boolean;
  isLoading: boolean;
  results: SearchResult[];
  selectedProject: SearchFilterState["project"];
  recentProjectOptions: SearchProjectOption[];
  preservedProjectOptions?: SearchProjectOption[];
  projectDisplayNames?: ReadonlyMap<string, string>;
}

export function buildSearchRequestOptions(
  filters: SearchFilterState,
  costMin: number | undefined,
): SearchRequestOptions {
  return {
    agent: filters.agent,
    sourceNodeId: filters.sourceNodeId,
    projectKind: filters.project?.kind,
    projectKey: filters.project?.key,
    tag: filters.tag,
    tool: filters.tool,
    fileKind: filters.fileKind,
    costMin,
  };
}

export function usesServerSearch(activeQuery: string, filters: SearchFilterState): boolean {
  return (
    activeQuery.trim().length > 0 ||
    Boolean(filters.tool || filters.fileKind || filters.sourceNodeId)
  );
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
  const inclusiveCosts =
    costMin === undefined ? null : buildSessionTree(sessionIndexes.sessionsByActivity).byRouteKey;
  const results: SearchResult[] = [];

  for (const sessionItem of sourceSessions) {
    const agentKey = getSessionAgentKey(sessionItem);
    if (filters.agent && agentKey !== filters.agent) continue;
    if (
      projectIdentityKey &&
      (!sessionItem.project_identity ||
        getProjectIdentityKey(sessionItem.project_identity) !== projectIdentityKey)
    ) {
      continue;
    }
    if (filters.tag && !sessionItem.smart_tags?.includes(filters.tag)) continue;
    const cost =
      inclusiveCosts?.get(
        getSessionRouteKey(
          agentKey,
          sessionItem.reference.sessionId,
          sessionItem.reference.sourceNodeId,
        ),
      )?.inclusiveStats.cost ?? sessionItem.stats.total_cost;
    if (costMin !== undefined && cost < costMin) continue;

    results.push({
      reference: sessionItem.reference,
      session: sessionItem,
      snippet: t("Recent session · {0}", [sessionItem.directory]),
      snippetHighlights: [],
      matchType: "recent" as const,
    });
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }

  return results;
}

function ensureSelectedProjectOption(
  options: SearchProjectOption[],
  selectedProject: SearchFilterState["project"],
  recentProjectOptions: SearchProjectOption[],
  projectDisplayNames?: ReadonlyMap<string, string>,
): SearchProjectOption[] {
  if (!selectedProject) return options.slice(0, 8);
  const selectedKey = getProjectIdentityKey(selectedProject);
  const existingIndex = options.findIndex((option) => option.key === selectedKey);
  if (existingIndex !== -1) {
    if (existingIndex < 8) return options.slice(0, 8);
    return [options[existingIndex]!, ...options.slice(0, 7)];
  }
  const fromRecent = recentProjectOptions.find((option) => option.key === selectedKey);
  const selectedOption: SearchProjectOption = fromRecent
    ? { ...fromRecent, count: 0, showCount: false }
    : {
        key: selectedKey,
        identityKind: selectedProject.kind,
        identityKey: selectedProject.key,
        label:
          resolveProjectDisplayName(
            {
              kind: selectedProject.kind,
              key: selectedProject.key,
              displayName: selectedProject.key,
            },
            projectDisplayNames,
          ) || selectedProject.key,
        count: 0,
        showCount: false,
      };
  return [selectedOption, ...options.slice(0, 7)];
}

export function buildSearchProjectOptions({
  usesServerSearch,
  isLoading,
  results,
  selectedProject,
  recentProjectOptions,
  preservedProjectOptions,
  projectDisplayNames,
}: SearchProjectOptionsInput): SearchProjectOption[] {
  if (!usesServerSearch) {
    return ensureSelectedProjectOption(
      recentProjectOptions,
      selectedProject,
      recentProjectOptions,
      projectDisplayNames,
    );
  }

  const preserved =
    preservedProjectOptions && preservedProjectOptions.length > 0
      ? preservedProjectOptions.map((option) => ({ ...option, showCount: false }))
      : recentProjectOptions.map((option) => ({ ...option, showCount: false }));

  if (isLoading) {
    return ensureSelectedProjectOption(
      preserved,
      selectedProject,
      recentProjectOptions,
      projectDisplayNames,
    );
  }

  const optionsByKey = new Map<string, SearchProjectOption>();
  for (const result of results) {
    const identity = result.session.project_identity;
    if (!identity?.key) continue;
    const key = getProjectIdentityKey(identity);
    const current = optionsByKey.get(key);
    if (current) {
      current.count += 1;
      if (
        !projectDisplayNames?.has(key) &&
        identity.displayName &&
        isGitRemoteFallbackDisplayName({
          kind: identity.kind,
          key: identity.key,
          displayName: current.label,
        }) &&
        !isGitRemoteFallbackDisplayName(identity)
      ) {
        current.label = identity.displayName;
      }
      continue;
    }
    optionsByKey.set(key, {
      key,
      identityKind: identity.kind,
      identityKey: identity.key,
      label: resolveProjectDisplayName(identity, projectDisplayNames) || result.session.directory,
      count: 1,
      showCount: false,
    });
  }

  const resultOptions = [...optionsByKey.values()].toSorted(
    (left, right) => right.count - left.count,
  );

  if (selectedProject) {
    // Server queries filtered by a project only return that single project,
    // so keep known options visible for one-click switching without clearing first.
    const merged = new Map<string, SearchProjectOption>();
    for (const option of preserved) {
      merged.set(option.key, option);
    }
    for (const option of resultOptions) {
      merged.set(option.key, option);
    }
    return ensureSelectedProjectOption(
      [...merged.values()],
      selectedProject,
      recentProjectOptions,
      projectDisplayNames,
    );
  }

  if (resultOptions.length === 0) {
    return preserved.slice(0, 8);
  }

  return resultOptions.slice(0, 8);
}
