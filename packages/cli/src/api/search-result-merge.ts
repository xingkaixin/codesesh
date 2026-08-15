import {
  formatSessionReference,
  normalizeSessionReference,
  type SearchResult,
  type SessionTree,
} from "@codesesh/core/contract";
import type { AliasView } from "./session-aliases-view.js";

/**
 * Sub-session hits render as 父 › 子, so each one needs its parent's title. The
 * index is built only when some hit actually has a parent — the common query
 * touches no sub-session at all.
 */
export function withParentContext(
  results: SearchResult[],
  getSessionTree: () => SessionTree,
  aliases: AliasView,
): SearchResult[] {
  if (!results.some((result) => result.session.parent_reference)) return results;
  const byRouteKey = getSessionTree().byRouteKey;

  return results.map((result) => {
    const parentReference = result.session.parent_reference;
    if (!parentReference) return result;
    const parent = byRouteKey.get(formatSessionReference(parentReference))?.session;
    if (!parent) return result;
    const reference = normalizeSessionReference(parentReference);
    return { ...result, parent: { reference, title: aliases.get(reference) ?? parent.title } };
  });
}

const ALIAS_SEARCH_RESULT_SHARE = 0.25;

function searchResultKey(result: SearchResult): string {
  return `${result.reference.agentName}\0${result.reference.sessionId}`;
}

function uniqueSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = searchResultKey(result);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeAliasSearchResults(
  rankedResults: SearchResult[],
  aliasResults: SearchResult[],
  limit: number,
): SearchResult[] {
  if (limit <= 0) return [];

  const ranked = uniqueSearchResults(rankedResults);
  const rankedKeys = new Set(ranked.map(searchResultKey));
  const aliases = uniqueSearchResults(aliasResults).filter(
    (result) => !rankedKeys.has(searchResultKey(result)),
  );
  if (ranked.length === 0) return aliases.slice(0, limit);
  if (aliases.length === 0) return ranked.slice(0, limit);

  // Alias hits have no BM25 score. Keep ranked search dominant while reserving
  // a bounded share so local renames remain discoverable.
  const aliasQuota = Math.min(
    limit - 1,
    Math.max(1, Math.floor(limit * ALIAS_SEARCH_RESULT_SHARE)),
  );
  const rankedQuota = limit - aliasQuota;
  return [
    ...ranked.slice(0, rankedQuota),
    ...aliases.slice(0, aliasQuota),
    ...ranked.slice(rankedQuota),
    ...aliases.slice(aliasQuota),
  ].slice(0, limit);
}
