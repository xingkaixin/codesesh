import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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
import { queryKeys } from "../lib/query-keys";

const EMPTY_SEARCH_RESULTS: SearchResult[] = [];

/**
 * Owns the committed session-search domain: query/filters state, the
 * local-vs-server result engine, keyboard-selection state, and result-scroll
 * behaviour. The search control owns its uncommitted input text.
 */
export function useSessionSearch(
  sessionIndexes: SessionIndexes,
  timeWindow: AppConfig["window"] | null = null,
) {
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilterState>({});
  const [requestedSearchIndex, setRequestedSearchIndex] = useState(0);
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
  const serverSearchQuery = useQuery({
    queryKey: queryKeys.search(activeSearchQuery, searchRequestOptions),
    enabled: searchMode && usesServerSearch,
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      logClientEvent("search.start", { query_length: activeSearchQuery.length });
      try {
        const data = await fetchSearchResults(activeSearchQuery, searchRequestOptions, { signal });
        logClientEvent("search.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          results: data.results.length,
        });
        return data.results;
      } catch (error) {
        if (!signal.aborted) {
          console.error("Failed to load search results:", error);
          logClientEvent("search.error", {
            duration_ms: Math.round(performance.now() - startedAt),
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        }
        throw error;
      }
    },
  });
  const searchState = useMemo<SearchLoadState>(() => {
    if (!searchMode) return { status: "idle" };
    if (!usesServerSearch) return { status: "loaded", results: recentSearchResults };
    if (serverSearchQuery.isPending) return { status: "loading" };
    if (serverSearchQuery.isError) {
      return {
        status: "failed",
        error:
          serverSearchQuery.error instanceof Error
            ? serverSearchQuery.error.message
            : "Search request failed",
      };
    }
    return { status: "loaded", results: serverSearchQuery.data };
  }, [recentSearchResults, searchMode, serverSearchQuery, usesServerSearch]);
  const searchResults = useMemo(
    () => (searchState.status === "loaded" ? searchState.results : EMPTY_SEARCH_RESULTS),
    [searchState],
  );
  const maxSearchIndex = Math.max(0, searchResults.length - 1);
  const selectedSearchIndex = Math.min(requestedSearchIndex, maxSearchIndex);
  const setSelectedSearchIndex = useCallback<Dispatch<SetStateAction<number>>>(
    (next) => {
      setRequestedSearchIndex((current) => {
        const boundedCurrent = Math.min(current, maxSearchIndex);
        const nextIndex = typeof next === "function" ? next(boundedCurrent) : next;
        return Math.max(0, Math.min(nextIndex, maxSearchIndex));
      });
    },
    [maxSearchIndex],
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
    if (!searchMode) return;
    const selectedResult = searchResults[selectedSearchIndex];
    if (!selectedResult) return;
    const key = `${selectedResult.reference.agentName}/${selectedResult.reference.sessionId}`;
    searchResultRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [searchMode, searchResults, selectedSearchIndex]);

  const openSearch = useCallback(() => {
    setSearchMode(true);
  }, []);

  const submitSearch = useCallback((query: string) => {
    setActiveSearchQuery(query.trim());
    setSearchMode(true);
    setRequestedSearchIndex(0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchMode(false);
    setActiveSearchQuery("");
  }, []);

  const retrySearch = useCallback(() => {
    void serverSearchQuery.refetch();
  }, [serverSearchQuery]);

  const registerResultRef = useCallback((key: string, node: HTMLAnchorElement | null) => {
    if (node) searchResultRefs.current.set(key, node);
    else searchResultRefs.current.delete(key);
  }, []);

  const refresh = useCallback(async () => {
    if (!(searchMode && usesServerSearch)) return;
    await serverSearchQuery.refetch();
  }, [searchMode, serverSearchQuery, usesServerSearch]);

  return {
    activeSearchQuery,
    searchMode,
    searchFilters,
    searchState,
    searchResults,
    searchLoading,
    projectOptions,
    usesServerSearch,
    selectedSearchIndex,
    registerResultRef,
    setSearchFilters,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
    retrySearch,
    refresh,
  };
}
