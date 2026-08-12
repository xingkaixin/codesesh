/**
 * Session aliases as a read model for the HTTP layer: load the user's local
 * renames once, then decorate outgoing records with `display_title`.
 */
import type { BookmarkView, SessionAlias, SessionHead } from "@codesesh/core";
import type { SearchResult, SessionReference } from "@codesesh/core/contract";
import {
  filterSessionSearchCandidates,
  getSessionActivityTime,
  listSessionAliases,
  mergeSearchQueryOptions,
  StateStorageUnavailableError,
  type FileActivityResult,
  type LiveSnapshot,
  type SearchOptions,
} from "@codesesh/core";
import { appLogger } from "../logging.js";

/** Anything the API returns that can carry a locally-renamed title. */
type Titled = { id: string; title: string; display_title?: string };

export interface AliasView {
  readonly size: number;
  get(reference: SessionReference): string | undefined;
  /** Returns the record unchanged when no alias applies, so callers can pass through freely. */
  decorate<T extends Titled>(record: T, reference: SessionReference): T;
  entries(): IterableIterator<SessionAlias>;
}

function aliasKey(reference: SessionReference): string {
  return `${reference.agentName.toLowerCase()}\0${reference.sessionId}`;
}

function loadAliasMap(): Map<string, SessionAlias> {
  try {
    return new Map(listSessionAliases().map((alias) => [aliasKey(alias.reference), alias]));
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
    get: (reference) => aliases.get(aliasKey(reference))?.alias,
    decorate(record, reference) {
      const alias = aliases.get(aliasKey(reference))?.alias;
      return alias ? { ...record, display_title: alias } : record;
    },
    entries: () => aliases.values(),
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

export function decorateBookmark(bookmark: BookmarkView, aliases: AliasView): BookmarkView {
  if (bookmark.availability === "available") {
    return {
      ...bookmark,
      session: aliases.decorate(bookmark.session, bookmark.reference),
    };
  }

  const displayTitle = aliases.get(bookmark.reference);
  return displayTitle ? { ...bookmark, display_title: displayTitle } : bookmark;
}

export function decorateFileActivity(
  activity: FileActivityResult,
  aliases: AliasView,
): FileActivityResult {
  return {
    ...activity,
    session: aliases.decorate(activity.session, activity.reference),
  };
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
  scanResult: LiveSnapshot,
  aliases: AliasView,
): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const needle = search.text.trim().toLowerCase();
  if (!needle || aliases.size === 0) return [];

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
  for (const alias of aliases.entries()) {
    if (!alias.alias.toLowerCase().includes(needle)) continue;
    const { agentName, sessionId } = alias.reference;
    const session = lookupSession(agentName, sessionId);
    if (!session) continue;
    results.push({
      reference: alias.reference,
      session: aliases.decorate(session, alias.reference),
      snippet: `Alias · ${session.directory}`,
      matchType: "title",
    });
  }

  return filterSessionSearchCandidates(results, search.options, scanResult.sessions).sort(
    (a, b) => getSessionActivityTime(b.session) - getSessionActivityTime(a.session),
  );
}
