/**
 * Deep session search: single owner for search-query interpretation
 * (qualifier parsing/merging), source selection between the live ScanResult
 * snapshot ("recent" path) and the SQLite search index (FTS / file-activity
 * paths), and cross-source result merging.
 */
import type { SessionHead } from "../types/index.js";
import type { SearchResult } from "../contract/index.js";
import {
  mergeSearchQueryOptions,
  searchSessions,
  sessionMatchesSearchCost,
  type ParsedSearchQuery,
  type SearchOptions,
} from "../discovery/cache/search.js";
import { searchFileActivitySessions } from "../discovery/cache/file-activity.js";
import {
  createProjectScopeMatcher,
  matchesProjectScope,
  type ProjectScopeMatcher,
} from "../projects/scope.js";
import { matchesProjectIdentity } from "../projects/identity.js";
import { getSessionActivityTime } from "../analytics/dashboard.js";

export interface SessionSearchSnapshot {
  sessions: SessionHead[];
  byAgent: Record<string, SessionHead[]>;
}

export function executeSessionSearch(
  query: string,
  options: SearchOptions,
  snapshot: SessionSearchSnapshot,
): SearchResult[] {
  const merged = mergeSearchQueryOptions(query, options);

  if (!needsIndexedSearch(merged.text, merged.options)) {
    return searchRecentSessions(snapshot, merged.options);
  }

  return searchIndexedSessions(query, merged.text, merged.parsed, merged.options);
}

// Qualifiers alone (tag:/cost:/agent:/project:) do not force the indexed
// path -- only text, file, fileKind, or tool do. A qualifier-only query is
// treated identically to an empty query for source selection.
function needsIndexedSearch(textQuery: string, options: SearchOptions): boolean {
  return Boolean(textQuery || options.file || options.fileKind || options.tools?.length);
}

function filterSessionsByActivityWindow(
  sessions: SessionHead[],
  from: number | undefined,
  to: number | undefined,
): SessionHead[] {
  if (from == null && to == null) return sessions;
  return sessions.filter((session) => {
    const activity = getSessionActivityTime(session);
    if (from != null && activity < from) return false;
    if (to != null && activity > to) return false;
    return true;
  });
}

function matchesRecentSearchFilters(
  session: SessionHead,
  options: SearchOptions,
  projectScope: ProjectScopeMatcher | null,
): boolean {
  if (options.projectKind || options.projectKey) {
    if (
      !options.projectKind ||
      !options.projectKey ||
      !matchesProjectIdentity(session.project_identity, {
        kind: options.projectKind,
        key: options.projectKey,
      })
    ) {
      return false;
    }
  }
  if (projectScope && !matchesProjectScope(session, projectScope)) return false;
  if (options.project) {
    const projectNeedle = options.project.toLowerCase();
    const projectText = [
      session.project_identity?.key,
      session.project_identity?.displayName,
      session.directory,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!projectText.includes(projectNeedle)) return false;
  }
  if (options.tags?.length && !options.tags.every((tag) => session.smart_tags?.includes(tag))) {
    return false;
  }
  if (!sessionMatchesSearchCost(session, options)) return false;
  return true;
}

function searchRecentSessions(
  snapshot: SessionSearchSnapshot,
  options: SearchOptions,
): SearchResult[] {
  const projectScope = options.cwd ? createProjectScopeMatcher(options.cwd) : null;
  const entries = options.agent
    ? ([[options.agent, snapshot.byAgent[options.agent] ?? []]] as Array<[string, SessionHead[]]>)
    : Object.entries(snapshot.byAgent);

  return entries
    .flatMap(([agentName, sessions]) =>
      filterSessionsByActivityWindow(sessions, options.from, options.to)
        .filter((session) => matchesRecentSearchFilters(session, options, projectScope))
        .map((session) => ({ agentName, session })),
    )
    .sort(
      (a, b) =>
        (b.session.time_updated ?? b.session.time_created) -
        (a.session.time_updated ?? a.session.time_created),
    )
    .slice(0, options.limit ?? 50)
    .map(({ agentName, session }) => ({
      agentName,
      session,
      snippet: `Recent session · ${session.directory}`,
      matchType: "recent",
    }));
}

// `options.file` already carries the qualifier's `file:`/`path:` value once
// merged (options.file ?? filters.file), so the middle branch only matters
// when options.file was merged from something other than this parse. When
// the query has no qualifiers at all, a bare text search is also attempted
// as a file-path search (usually a no-op match, but it is why plain text
// queries still touch the file-activity path).
function deriveFileQuery(query: string, parsed: ParsedSearchQuery, options: SearchOptions): string {
  return (
    options.file ??
    (!parsed.text ? parsed.filters.file : undefined) ??
    (!parsed.hasQualifiers && query ? parsed.text || query : "")
  );
}

function mergeSearchResultSources(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const result of results) {
    const key = `${result.agentName}/${result.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) break;
  }

  return merged;
}

// searchSessions is the only source when: there's text (FTS is the primary
// source), tools are filtered (its empty-query SQL branch is the sole source
// for tool-only queries), tags are filtered (listFileActivity has no tag
// clause), or a from/to window is set (file-activity filters by
// fa.latest_time, not the session's activity_time, so it can't stand in).
// Otherwise, once a file path narrowed the results, the file-activity path
// already covers everything and re-querying sessions is redundant.
function canSkipSessionsSearch(
  fileQuery: string,
  textQuery: string,
  options: SearchOptions,
): boolean {
  return Boolean(
    fileQuery &&
    !textQuery &&
    !options.tools?.length &&
    !options.tags?.length &&
    options.from == null &&
    options.to == null,
  );
}

function searchIndexedSessions(
  query: string,
  textQuery: string,
  parsed: ParsedSearchQuery,
  options: SearchOptions,
): SearchResult[] {
  const fileQuery = deriveFileQuery(query, parsed, options);
  const fileResults = fileQuery ? searchFileActivitySessions(fileQuery, options) : [];
  const sessionResults = canSkipSessionsSearch(fileQuery, textQuery, options)
    ? []
    : searchSessions(query, options);

  return mergeSearchResultSources([...fileResults, ...sessionResults], options.limit ?? 50);
}
