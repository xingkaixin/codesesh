/**
 * Deep session search: single owner for search-query interpretation
 * (qualifier parsing/merging), source selection between the live LiveSnapshot
 * snapshot ("recent" path) and the SQLite search index (FTS / file-activity
 * paths), and cross-source result merging.
 */
import type { SessionHead } from "../types/index.js";
import {
  buildSessionTree,
  getSessionAgentKey,
  getSessionRouteKey,
  type SearchResult,
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
import {
  createProjectScopeMatcher,
  matchesProjectScope,
  type ProjectScopeMatcher,
} from "../projects/scope.js";
import { matchesProjectIdentity } from "../projects/identity.js";
import { getSessionActivityTime } from "../analytics/dashboard.js";

export interface SessionSearchSnapshot {
  /** Globally sorted by activity descending; ties preserve the canonical live-index order. */
  sessions: SessionHead[];
  /** Each shard follows the same activity ordering as `sessions`. */
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

function sessionReferenceKey(agentName: string, sessionId: string): string {
  return `${agentName}\u0000${sessionId}`;
}

export function filterSessionSearchCandidates(
  candidates: SearchResult[],
  options: SearchOptions,
  sessionSnapshot: SessionHead[] = candidates.map((candidate) => candidate.session),
): SearchResult[] {
  const projectScope = options.cwd ? createProjectScopeMatcher(options.cwd) : null;
  const inclusiveCosts = buildInclusiveCostLookup(sessionSnapshot, options);
  const headMatches = candidates.filter((candidate) =>
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
    indexedMatches.has(
      sessionReferenceKey(candidate.reference.agentName, candidate.reference.sessionId),
    ),
  );
}

function searchRecentSessions(
  snapshot: SessionSearchSnapshot,
  options: SearchOptions,
): SearchResult[] {
  const limit = Math.max(0, Math.trunc(options.limit ?? 50));
  if (limit === 0) return [];

  const projectScope = options.cwd ? createProjectScopeMatcher(options.cwd) : null;
  const inclusiveCosts = buildInclusiveCostLookup(snapshot.sessions, options);
  const sessions = options.agent ? (snapshot.byAgent[options.agent] ?? []) : snapshot.sessions;
  const results: SearchResult[] = [];

  for (const session of sessions) {
    const agentName = options.agent ?? getSessionAgentKey(session);
    if (
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
      reference: { agentName, sessionId: session.id },
      session,
      snippet: `Recent session · ${session.directory}`,
      matchType: "recent",
    });
    if (results.length >= limit) break;
  }

  return results;
}

function buildInclusiveCostLookup(
  sessions: SessionHead[],
  options: SearchOptions,
): ReturnType<typeof buildSessionTree>["byRouteKey"] | null {
  if (options.costMin == null && options.costMax == null) return null;
  return buildSessionTree(sessions).byRouteKey;
}

function inclusiveCostFor(
  agentName: string,
  session: SessionHead,
  lookup: ReturnType<typeof buildSessionTree>["byRouteKey"] | null,
): number {
  return (
    lookup?.get(getSessionRouteKey(agentName, session.id))?.inclusiveStats.cost ??
    session.stats.total_cost
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
    const key = sessionReferenceKey(result.reference.agentName, result.reference.sessionId);
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
): SearchResult[] {
  const fileQuery = deriveFileQuery(query, parsed, options);
  const fileResults = fileQuery ? searchFileActivitySessions(fileQuery, options) : [];
  const sessionResults = canSkipSessionsSearch(fileQuery, textQuery)
    ? []
    : searchSessions(query, options);
  const textMatchReferences =
    textQuery && options.file
      ? new Set(
          sessionResults.map((result) =>
            sessionReferenceKey(result.reference.agentName, result.reference.sessionId),
          ),
        )
      : null;
  const matchingFileResults = textMatchReferences
    ? fileResults.filter((result) =>
        textMatchReferences.has(
          sessionReferenceKey(result.reference.agentName, result.reference.sessionId),
        ),
      )
    : fileResults;

  return mergeSearchResultSources([...matchingFileResults, ...sessionResults], options.limit ?? 50);
}
