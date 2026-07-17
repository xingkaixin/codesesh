import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AppConfig,
  type SearchRequestOptions,
  type SearchResult,
  fetchSearchResults,
  logClientEvent,
} from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import type { SearchFilterState, SearchLoadState } from "../components/app/types";
import { COST_RANGE_OPTIONS } from "../components/app/SearchFilterBar";
import {
  buildLocalRecentResults,
  buildSearchProjectOptions,
  buildSearchRequestOptions,
  usesServerSearch as computeUsesServerSearch,
} from "../lib/search";

/**
 * Owns the session-search domain: query/filters state, the local-vs-server
 * result engine, keyboard-selection state, and result-scroll behaviour.
 * Exposes semantic actions (open/submit/close); the global keydown handler
 * stays in App and drives selection via the returned state + setters.
 */
export function useSessionSearch(
  sessionIndexes: SessionIndexes,
  timeWindow: AppConfig["window"] | null = null,
) {
  const [draftSearchQuery, setDraftSearchQuery] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilterState>({});
  const [searchState, setSearchState] = useState<SearchLoadState>({ status: "idle" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchResultRefs = useRef(new Map<string, HTMLAnchorElement>());

  const costMin = useMemo(
    () => COST_RANGE_OPTIONS.find((option) => option.id === searchFilters.costRange)?.costMin,
    [searchFilters.costRange],
  );

  const searchRequestOptions = useMemo<SearchRequestOptions>(
    () => ({
      ...buildSearchRequestOptions(searchFilters, costMin),
      from: timeWindow?.from,
      to: timeWindow?.to,
    }),
    [searchFilters, costMin, timeWindow],
  );

  const usesServerSearch = computeUsesServerSearch(activeSearchQuery, searchFilters);

  const recentSearchResults = useMemo<SearchResult[]>(
    () => buildLocalRecentResults(sessionIndexes, searchFilters, costMin),
    [sessionIndexes, searchFilters, costMin],
  );
  const searchResults = useMemo(
    () => (searchState.status === "loaded" ? searchState.results : []),
    [searchState],
  );
  const searchLoading = searchState.status === "loading";
  const projectOptions = useMemo(
    () =>
      buildSearchProjectOptions({
        usesServerSearch,
        isLoading: searchLoading,
        results: searchResults,
        selectedProject: searchFilters.project,
        recentProjectOptions: sessionIndexes.projectOptions,
      }),
    [
      searchFilters.project,
      searchLoading,
      searchResults,
      sessionIndexes.projectOptions,
      usesServerSearch,
    ],
  );

  useEffect(() => {
    if (!searchMode) {
      setSearchState({ status: "idle" });
      return;
    }
    if (!usesServerSearch) {
      setSearchState({ status: "loaded", results: recentSearchResults });
      return;
    }

    let cancelled = false;
    setSearchState({ status: "loading" });
    const startedAt = performance.now();
    logClientEvent("search.start", { query_length: activeSearchQuery.length });

    void fetchSearchResults(activeSearchQuery, searchRequestOptions)
      .then((data) => {
        if (cancelled) return;
        setSearchState({ status: "loaded", results: data.results });
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
        setSearchState({
          status: "failed",
          error: err instanceof Error ? err.message : "Search request failed",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSearchQuery,
    recentSearchResults,
    retryVersion,
    searchMode,
    searchRequestOptions,
    usesServerSearch,
  ]);

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

  const retrySearch = useCallback(() => {
    setRetryVersion((version) => version + 1);
  }, []);

  const registerResultRef = useCallback((key: string, node: HTMLAnchorElement | null) => {
    if (node) searchResultRefs.current.set(key, node);
    else searchResultRefs.current.delete(key);
  }, []);

  const refresh = useCallback(async () => {
    if (!(searchMode && usesServerSearch)) return;
    try {
      const data = await fetchSearchResults(activeSearchQuery, searchRequestOptions);
      setSearchState({ status: "loaded", results: data.results });
    } catch (err) {
      console.error("Failed to refresh search results:", err);
      setSearchState({
        status: "failed",
        error: err instanceof Error ? err.message : "Search request failed",
      });
    }
  }, [searchMode, usesServerSearch, activeSearchQuery, searchRequestOptions]);

  return {
    draftSearchQuery,
    activeSearchQuery,
    searchMode,
    searchFilters,
    searchState,
    searchResults,
    searchLoading,
    projectOptions,
    usesServerSearch,
    selectedSearchIndex,
    searchInputRef,
    registerResultRef,
    setDraftSearchQuery,
    setSearchFilters,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
    retrySearch,
    refresh,
  };
}
