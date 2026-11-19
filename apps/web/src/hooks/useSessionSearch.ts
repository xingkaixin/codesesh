import { getSessionReferenceKey, type AppConfig, type SearchResult } from "@codesesh/contract";
import { t } from "../i18n/translate";
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
import { useLocation, useNavigate } from "react-router-dom";
import { type SearchRequestOptions, fetchSearchResults, logClientEvent } from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import type {
  SearchFilterState,
  SearchLoadState,
  SearchProjectOption,
} from "../components/app/types";
import {
  COST_RANGE_OPTIONS,
  buildLocalRecentResults,
  buildSearchProjectOptions,
  buildSearchRequestOptions,
  readSearchUrlState,
  usesServerSearch as computeUsesServerSearch,
  writeSearchUrlState,
  type SearchUrlState,
} from "../lib/search";
import { queryKeys } from "../lib/query-keys";

const EMPTY_SEARCH_RESULTS: SearchResult[] = [];

function areProjectOptionsEqual(
  left: readonly SearchProjectOption[],
  right: readonly SearchProjectOption[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.key !== b.key || a.label !== b.label || a.count !== b.count) return false;
  }
  return true;
}

/**
 * Owns the committed session-search domain: URL-backed query/filters state, the
 * local-vs-server result engine, keyboard/hover selection state, and result-scroll
 * behaviour. The search control owns its uncommitted input text.
 */
export function useSessionSearch(
  sessionIndexes: SessionIndexes,
  timeWindow: AppConfig["window"] | null = null,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const urlSearchState = useMemo(
    () => readSearchUrlState(new URLSearchParams(location.search)),
    [location.search],
  );
  const { active: searchMode, query: activeSearchQuery, filters: searchFilters } = urlSearchState;
  const [requestedSearchIndex, setRequestedSearchIndex] = useState(0);
  const [preservedProjectOptions, setPreservedProjectOptions] = useState<SearchProjectOption[]>([]);
  const searchResultRefs = useRef(new Map<string, HTMLAnchorElement>());
  const shouldScrollSelectedRef = useRef(false);

  const writeSearchUrl = useCallback(
    (nextState: SearchUrlState, { replace }: { replace: boolean }) => {
      const nextParams = writeSearchUrlState(new URLSearchParams(location.search), nextState);
      const nextSearch = nextParams.toString();
      const currentSearch = location.search.startsWith("?")
        ? location.search.slice(1)
        : location.search;
      if (nextSearch === currentSearch) return;
      navigate(
        {
          pathname: location.pathname,
          search: nextSearch ? `?${nextSearch}` : "",
          hash: location.hash,
        },
        { replace, state: location.state },
      );
    },
    [location.hash, location.pathname, location.search, location.state, navigate],
  );

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
            : t("Search request failed"),
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
      shouldScrollSelectedRef.current = true;
      setRequestedSearchIndex((current) => {
        const boundedCurrent = Math.min(current, maxSearchIndex);
        const nextIndex = typeof next === "function" ? next(boundedCurrent) : next;
        return Math.max(0, Math.min(nextIndex, maxSearchIndex));
      });
    },
    [maxSearchIndex],
  );
  const selectSearchIndex = useCallback(
    (index: number) => {
      shouldScrollSelectedRef.current = false;
      setRequestedSearchIndex(Math.max(0, Math.min(index, maxSearchIndex)));
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
        preservedProjectOptions,
        projectDisplayNames: sessionIndexes.projectDisplayNames,
      }),
    [
      preservedProjectOptions,
      searchFilters.project,
      searchLoading,
      searchResults,
      sessionIndexes.projectDisplayNames,
      sessionIndexes.projectOptions,
      usesServerSearch,
    ],
  );

  if (
    searchMode &&
    usesServerSearch &&
    !searchLoading &&
    !searchFilters.project &&
    searchResults.length > 0 &&
    !areProjectOptionsEqual(preservedProjectOptions, projectOptions)
  ) {
    setPreservedProjectOptions(projectOptions);
  }

  useEffect(() => {
    if (!searchMode || !shouldScrollSelectedRef.current) return;
    shouldScrollSelectedRef.current = false;
    const selectedResult = searchResults[selectedSearchIndex];
    if (!selectedResult) return;
    const key = getSessionReferenceKey(selectedResult.reference);
    searchResultRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [searchMode, searchResults, selectedSearchIndex]);

  const openSearch = useCallback(() => {
    if (searchMode) return;
    writeSearchUrl({ active: true, query: "", filters: {} }, { replace: false });
  }, [searchMode, writeSearchUrl]);

  const submitSearch = useCallback(
    (query: string) => {
      writeSearchUrl(
        { active: true, query: query.trim(), filters: searchFilters },
        { replace: searchMode },
      );
      setRequestedSearchIndex(0);
    },
    [searchFilters, searchMode, writeSearchUrl],
  );

  const setSearchFilters = useCallback(
    (next: SetStateAction<SearchFilterState>, draftQuery?: string) => {
      const nextFilters = typeof next === "function" ? next(searchFilters) : next;
      if (nextFilters.project !== searchFilters.project) setPreservedProjectOptions(projectOptions);
      const nextQuery = draftQuery !== undefined ? draftQuery.trim() : activeSearchQuery;
      writeSearchUrl(
        { active: true, query: nextQuery, filters: nextFilters },
        { replace: searchMode },
      );
      setRequestedSearchIndex(0);
    },
    [activeSearchQuery, projectOptions, searchFilters, searchMode, writeSearchUrl],
  );

  const closeSearch = useCallback(() => {
    if (!searchMode) return;
    writeSearchUrl({ active: false, query: "", filters: {} }, { replace: false });
  }, [searchMode, writeSearchUrl]);

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
    projectDisplayNames: sessionIndexes.projectDisplayNames,
    usesServerSearch,
    selectedSearchIndex,
    registerResultRef,
    setSearchFilters,
    setSelectedSearchIndex,
    selectSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
    retrySearch,
    refresh,
  };
}
