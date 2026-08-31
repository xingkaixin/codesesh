/**
 * Deep session search: single owner for search-query interpretation
 * (qualifier parsing/merging), source selection between the live LiveSnapshot
 * snapshot ("recent" path) and the SQLite search index (FTS / file-activity
 * paths), and cross-source result merging.
 */
import type { SessionHead } from "../types/index.js";
import {
  buildSessionTree,
  getSessionReferenceKey,
  type SearchResult,
  type SessionTree,
} from "../contract/index.js";
import {
  filterIndexedSessionReferences,
  mergeSearchQueryOptions,
  searchSessions,
  sessionMatchesSearchCost,
  type ParsedSearchQuery,
  type SearchOptions,
} from "../discovery/cache/search.js";
import { searchFileActivitySessions } from "../discovery/cache/file-activity.js";
import { matchesProjectScope, type ProjectScopeMatcher } from "../projects/scope.js";
import { matchesProjectIdentity } from "../projects/identity.js";
import { getSessionActivityTime } from "../analytics/dashboard.js";
import { matchesSessionQueryScope, type SessionQueryScope } from "../discovery/session-scope.js";

export interface SessionSearchSnapshot {
  /** Globally sorted by activity descending; ties preserve the canonical live-index order. */
  sessions: SessionHead[];
  /** Each shard follows the same activity ordering as `sessions`. */
  byAgent: Record<string, SessionHead[]>;
}

export interface SessionSearchContext {
  sessionTree?: SessionTree;
  queryScope?: SessionQueryScope;
}

export interface SessionSearchFilterContext extends SessionSearchContext {
  sessionSnapshot?: SessionHead[];
}

export function executeSessionSearch(
  query: string,
  options: SearchOptions,
  snapshot: SessionSearchSnapshot,
  context: SessionSearchContext = {},
): SearchResult[] {
  const merged = mergeSearchQueryOptions(query, options);

  if (!needsIndexedSearch(merged.text, merged.options)) {
    return searchRecentSessions(snapshot, merged.options, context);
  }

  return searchIndexedSessions(
    query,
    merged.text,
    merged.parsed,
    merged.options,
    context.queryScope,
  );
}

// Qualifiers alone (tag:/cost:/agent:/project:) do not force the indexed
// path -- only text, file, fileKind, or tool do. A qualifier-only query is
// treated identically to an empty query for source selection.
function needsIndexedSearch(textQuery: string, options: SearchOptions): boolean {
  return Boolean(textQuery || options.file || options.fileKind || options.tools?.length);
}

function matchesRecentSearchFilters(
  session: SessionHead,
  options: SearchOptions,
  projectScope: ProjectScopeMatcher | null,
  inclusiveCost: number,
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
  if (!sessionMatchesSearchCost(session, options, inclusiveCost)) return false;
  return true;
}

// Evaluates filters answerable from SessionHead. File and tool predicates
// require the indexed batch seam in filterSessionSearchCandidates.
export function matchesSessionSearchFilters(
  agentName: string,
  session: SessionHead,
  options: SearchOptions,
  projectScope: ProjectScopeMatcher | null = null,
  inclusiveCost = session.stats.total_cost,
): boolean {
  if (options.agent && agentName !== options.agent) return false;
  const activity = getSessionActivityTime(session);
  if (options.from != null && activity < options.from) return false;
  if (options.to != null && activity > options.to) return false;
  return matchesRecentSearchFilters(session, options, projectScope, inclusiveCost);
}

export function filterSessionSearchCandidates(
  candidates: SearchResult[],
  options: SearchOptions,
  context: SessionSearchFilterContext = {},
): SearchResult[] {
  const projectScope = options.projectScope ?? null;
  const sessionSnapshot =
    context.sessionSnapshot ?? candidates.map((candidate) => candidate.session);
  const inclusiveCosts = buildInclusiveCostLookup(sessionSnapshot, options, context.sessionTree);
  const headMatches = candidates.filter(
    (candidate) =>
      matchesSessionQueryScope(candidate.session, context.queryScope) &&
      matchesSessionSearchFilters(
        candidate.reference.agentName,
        candidate.session,
        options,
        projectScope,
        inclusiveCostFor(candidate.reference.agentName, candidate.session, inclusiveCosts),
      ),
  );
  if (!options.file && !options.fileKind && !options.tools?.length) return headMatches;

  const indexedMatches = filterIndexedSessionReferences(
    headMatches.map((candidate) => ({
      agentName: candidate.reference.agentName,
      sessionId: candidate.reference.sessionId,
    })),
    {
      file: options.file,
      fileKind: options.fileKind,
      tools: options.tools,
    },
  );
  return headMatches.filter((candidate) =>
    indexedMatches.has(getSessionReferenceKey(candidate.reference)),
  );
}

function searchRecentSessions(
  snapshot: SessionSearchSnapshot,
  options: SearchOptions,
  context: SessionSearchContext,
): SearchResult[] {
  const limit = Math.max(0, Math.trunc(options.limit ?? 50));
  if (limit === 0) return [];

  const projectScope = options.projectScope ?? null;
  const inclusiveCosts = buildInclusiveCostLookup(snapshot.sessions, options, context.sessionTree);
  const sessions = options.agent ? (snapshot.byAgent[options.agent] ?? []) : snapshot.sessions;
  const results: SearchResult[] = [];

  for (const session of sessions) {
    const agentName = options.agent ?? session.reference.agentName;
    if (
      !matchesSessionQueryScope(session, context.queryScope) ||
      !matchesSessionSearchFilters(
        agentName,
        session,
        options,
        projectScope,
        inclusiveCostFor(agentName, session, inclusiveCosts),
      )
    ) {
      continue;
    }
    results.push({
      reference: session.reference,
      session,
      snippet: `Recent session · ${session.directory}`,
      snippetHighlights: [],
      matchType: "recent",
    });
    if (results.length >= limit) break;
  }

  return results;
}

function buildInclusiveCostLookup(
  sessions: SessionHead[],
  options: SearchOptions,
  sessionTree?: SessionTree,
): ReturnType<typeof buildSessionTree>["byRouteKey"] | null {
  if (options.costMin == null && options.costMax == null) return null;
  return (sessionTree ?? buildSessionTree(sessions)).byRouteKey;
}

function inclusiveCostFor(
  agentName: string,
  session: SessionHead,
  lookup: ReturnType<typeof buildSessionTree>["byRouteKey"] | null,
): number {
  return (
    lookup?.get(getSessionReferenceKey({ agentName, sessionId: session.reference.sessionId }))
      ?.inclusiveStats.cost ?? session.stats.total_cost
  );
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
    const key = getSessionReferenceKey(result.reference);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) break;
  }

  return merged;
}

function canSkipSessionsSearch(fileQuery: string, textQuery: string): boolean {
  return Boolean(fileQuery && !textQuery);
}

function searchIndexedSessions(
  query: string,
  textQuery: string,
  parsed: ParsedSearchQuery,
  options: SearchOptions,
  queryScope?: SessionQueryScope,
): SearchResult[] {
  const fileQuery = deriveFileQuery(query, parsed, options);
  const fileResults = fileQuery ? searchFileActivitySessions(fileQuery, options, queryScope) : [];
  const sessionResults = canSkipSessionsSearch(fileQuery, textQuery)
    ? []
    : searchSessions(query, options, queryScope);
  const textMatchReferences =
    textQuery && options.file
      ? new Set(sessionResults.map((result) => getSessionReferenceKey(result.reference)))
      : null;
  const matchingFileResults = textMatchReferences
    ? fileResults.filter((result) =>
        textMatchReferences.has(getSessionReferenceKey(result.reference)),
      )
    : fileResults;

  return mergeSearchResultSources([...matchingFileResults, ...sessionResults], options.limit ?? 50);
}
