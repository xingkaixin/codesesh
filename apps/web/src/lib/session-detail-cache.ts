/**
 * Bounds how many full transcripts the browser keeps.
 *
 * A session detail carries every message and part; parsed, it costs more heap
 * than the response did bytes. TanStack Query's default keeps an inactive query
 * for five minutes, so browsing ten large sessions in a row held all ten — the
 * cache was bounded by how fast someone clicked, not by anything structural.
 *
 * The bound here is a count, not a shorter timeout: the active detail plus a
 * couple of recent ones, so going back one session is still instant.
 */
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";

export const RETAINED_INACTIVE_SESSION_DETAILS = 2;

const SESSION_DETAIL_PREFIX = queryKeys.sessionDetails[0];

/** Drops the least recently used inactive details beyond the retained count. */
export function pruneSessionDetailCache(client: QueryClient): void {
  const cache = client.getQueryCache();
  const inactive = cache
    .getAll()
    .map((query, position) => ({ query, position }))
    .filter(
      ({ query }) => query.queryKey[0] === SESSION_DETAIL_PREFIX && query.getObserversCount() === 0,
    )
    // Newest first. Two details fetched in the same millisecond tie on
    // dataUpdatedAt, so cache insertion order breaks it.
    .sort(
      (left, right) =>
        right.query.state.dataUpdatedAt - left.query.state.dataUpdatedAt ||
        right.position - left.position,
    );

  for (const { query } of inactive.slice(RETAINED_INACTIVE_SESSION_DETAILS)) {
    cache.remove(query);
  }
}

/**
 * Applies the bound when a detail stops being observed — the moment a
 * transcript becomes retained rather than displayed. Returns an unsubscribe.
 */
export function installSessionDetailCachePolicy(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "observerRemoved") return;
    pruneSessionDetailCache(client);
  });
}
