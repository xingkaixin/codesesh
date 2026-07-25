/**
 * Session aliases as a read model for the HTTP layer: load the user's local
 * renames once, then decorate outgoing records with `display_title`.
 */
import type { BookmarkRecord, SessionHead } from "@codesesh/core";
import type { SearchResult } from "@codesesh/core/contract";
import {
  createProjectScopeMatcher,
  getSessionActivityTime,
  listSessionAliases,
  matchesSessionSearchFilters,
  mergeSearchQueryOptions,
  StateStorageUnavailableError,
  type FileActivityResult,
  type ScanResult,
  type SearchOptions,
} from "@codesesh/core";
import { appLogger } from "../logging.js";

/** Anything the API returns that can carry a locally-renamed title. */
type Titled = { id: string; title: string; display_title?: string };

export interface AliasView {
  readonly size: number;
  get(agentKey: string, sessionId: string): string | undefined;
  /** Returns the record unchanged when no alias applies, so callers can pass through freely. */
  decorate<T extends Titled>(record: T, agentKey: string): T;
  entries(): IterableIterator<[string, string]>;
}

function aliasKey(agentKey: string, sessionId: string): string {
  return `${agentKey.toLowerCase()}\0${sessionId}`;
}

function splitAliasKey(key: string): { agentName: string; sessionId: string } {
  const separatorIndex = key.indexOf("\0");
  return { agentName: key.slice(0, separatorIndex), sessionId: key.slice(separatorIndex + 1) };
}

export function getSessionAgentKey(session: Pick<SessionHead, "slug">): string {
  return session.slug.split("/")[0]?.toLowerCase() ?? "";
}

function loadAliasMap(): Map<string, string> {
  try {
    return new Map(
      listSessionAliases().map((alias) => [aliasKey(alias.agentKey, alias.sessionId), alias.alias]),
    );
  } catch (error) {
    if (!(error instanceof StateStorageUnavailableError)) {
      appLogger.warn("api.session_aliases.load_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return new Map();
  }
}

function buildAliasView(): AliasView {
  const aliases = loadAliasMap();
  return {
    size: aliases.size,
    get: (agentKey, sessionId) => aliases.get(aliasKey(agentKey, sessionId)),
    decorate(record, agentKey) {
      const alias = aliases.get(aliasKey(agentKey, record.id));
      return alias ? { ...record, display_title: alias } : record;
    },
    entries: () => aliases.entries(),
  };
}

/**
 * Aliases change only through this process's own PUT/DELETE handlers, so the
 * read model is built once and reused until one of them invalidates it. Six read
 * handlers call this per request; without the cache each one re-queries the whole
 * table. A storage failure is cached too — it does not heal between requests, and
 * invalidateAliasView() is what lets a recovered store be retried.
 */
let cachedView: AliasView | null = null;

export function loadAliasView(): AliasView {
  return (cachedView ??= buildAliasView());
}

export function invalidateAliasView(): void {
  cachedView = null;
}

export function decorateBookmark(bookmark: BookmarkRecord, aliases: AliasView): BookmarkRecord {
  const alias = aliases.get(bookmark.agentKey, bookmark.sessionId);
  return alias ? { ...bookmark, display_title: alias } : bookmark;
}

export function decorateFileActivity(
  activity: FileActivityResult,
  aliases: AliasView,
): FileActivityResult {
  return { ...activity, session: aliases.decorate(activity.session, activity.agent_name) };
}

/**
 * Aliases are stored outside the search index, so a query matching only a local
 * rename has to be resolved here. Hits still have to satisfy the same
 * time-window / project / agent filters as the main search, otherwise an aliased
 * session could surface outside its search scope.
 */
export function findAliasSearchResults(
  query: string,
  options: SearchOptions,
  scanResult: ScanResult,
  aliases: AliasView,
): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const needle = search.text.trim().toLowerCase();
  if (!needle || aliases.size === 0) return [];

  const projectScope = search.options.cwd ? createProjectScopeMatcher(search.options.cwd) : null;
  const sessionsByAgent = new Map<string, Map<string, SessionHead>>();
  const lookupSession = (agentName: string, sessionId: string): SessionHead | undefined => {
    let byId = sessionsByAgent.get(agentName);
    if (!byId) {
      byId = new Map((scanResult.byAgent[agentName] ?? []).map((item) => [item.id, item]));
      sessionsByAgent.set(agentName, byId);
    }
    return byId.get(sessionId);
  };

  const results: SearchResult[] = [];
  for (const [key, alias] of aliases.entries()) {
    if (!alias.toLowerCase().includes(needle)) continue;
    const { agentName, sessionId } = splitAliasKey(key);
    const session = lookupSession(agentName, sessionId);
    if (!session) continue;
    if (!matchesSessionSearchFilters(agentName, session, search.options, projectScope)) continue;
    results.push({
      agentName,
      session: aliases.decorate(session, agentName),
      snippet: `Alias · ${session.directory}`,
      matchType: "title",
    });
  }

  return results.sort(
    (a, b) => getSessionActivityTime(b.session) - getSessionActivityTime(a.session),
  );
}
