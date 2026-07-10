import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type SearchRequestOptions,
  type SearchResult,
  fetchSearchResults,
  logClientEvent,
} from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import type { SearchFilterState } from "../components/app/types";
import { COST_RANGE_OPTIONS } from "../components/app/SearchFilterBar";
import {
  buildLocalRecentResults,
  buildSearchRequestOptions,
  usesServerSearch as computeUsesServerSearch,
} from "../lib/search";

/**
 * Owns the session-search domain: query/filters state, the local-vs-server
 * result engine, keyboard-selection state, and result-scroll behaviour.
 * Exposes semantic actions (open/submit/close) and refresh() for the
 * live-update subscription; the global keydown handler stays in App and
 * drives selection via the returned state + setters.
 */
export function useSessionSearch(sessionIndexes: SessionIndexes) {
  const [draftSearchQuery, setDraftSearchQuery] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilterState>({});
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchResultRefs = useRef(new Map<string, HTMLAnchorElement>());

  const costMin = useMemo(
    () => COST_RANGE_OPTIONS.find((option) => option.id === searchFilters.costRange)?.costMin,
    [searchFilters.costRange],
  );

  const searchRequestOptions = useMemo<SearchRequestOptions>(
    () => buildSearchRequestOptions(searchFilters, costMin),
    [searchFilters, costMin],
  );

  const usesServerSearch = computeUsesServerSearch(activeSearchQuery, searchFilters);

  const recentSearchResults = useMemo<SearchResult[]>(
    () => buildLocalRecentResults(sessionIndexes, searchFilters, costMin),
    [sessionIndexes, searchFilters, costMin],
  );

  useEffect(() => {
    if (!searchMode) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    if (!usesServerSearch) {
      setSearchResults(recentSearchResults);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    const startedAt = performance.now();
    logClientEvent("search.start", { query_length: activeSearchQuery.length });

    void fetchSearchResults(activeSearchQuery, searchRequestOptions)
      .then((data) => {
        if (cancelled) return;
        setSearchResults(data.results);
        logClientEvent("search.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          results: data.results.length,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load search results:", err);
        logClientEvent("search.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setSearchResults([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSearchQuery, searchMode, recentSearchResults, searchRequestOptions, usesServerSearch]);

  useEffect(() => {
    if (!searchMode) return;
    setSelectedSearchIndex((current) => {
      if (searchResults.length === 0) return 0;
      return Math.min(current, searchResults.length - 1);
    });
  }, [searchMode, searchResults.length]);

  useEffect(() => {
    if (!searchMode) return;
    const selectedResult = searchResults[selectedSearchIndex];
    if (!selectedResult) return;
    const key = `${selectedResult.agentName}/${selectedResult.session.id}`;
    searchResultRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [searchMode, searchResults, selectedSearchIndex]);

  const openSearch = useCallback(() => {
    setSearchMode(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, []);

  const submitSearch = useCallback(() => {
    setActiveSearchQuery(draftSearchQuery.trim());
    setSearchMode(true);
    setSelectedSearchIndex(0);
  }, [draftSearchQuery]);

  const closeSearch = useCallback(() => {
    setSearchMode(false);
    setActiveSearchQuery("");
  }, []);

  const refresh = useCallback(async () => {
    if (!(searchMode && usesServerSearch)) return;
    try {
      const data = await fetchSearchResults(activeSearchQuery, searchRequestOptions);
      setSearchResults(data.results);
    } catch (err) {
      console.error("Failed to refresh search results:", err);
    }
  }, [searchMode, usesServerSearch, activeSearchQuery, searchRequestOptions]);

  return {
    draftSearchQuery,
    activeSearchQuery,
    searchMode,
    searchFilters,
    searchResults,
    searchLoading,
    usesServerSearch,
    selectedSearchIndex,
    searchInputRef,
    searchResultRefs,
    setDraftSearchQuery,
    setSearchFilters,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
    refresh,
  };
}
