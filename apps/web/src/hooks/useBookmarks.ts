import {
  type QueryClient,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import {
  type BookmarkView,
  type SessionHead,
  deleteBookmark,
  fetchBookmarks,
  importBookmarks,
  logClientEvent,
  upsertBookmark,
} from "../lib/api";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  toBookmarkView,
} from "../lib/bookmarks";
import { queryKeys } from "../lib/query-keys";

interface ToggleBookmarkVariables {
  bookmark: BookmarkView;
  isBookmarked: boolean;
}

const EMPTY_BOOKMARKS: BookmarkView[] = [];
const BOOKMARK_TOGGLE_MUTATION_KEY = ["bookmarks", "toggle"] as const;
const BOOKMARK_WRITE_SCOPE = { id: "bookmark-writes" };

function toggledBookmarks(
  bookmarks: BookmarkView[],
  bookmark: BookmarkView,
  isBookmarked: boolean,
): BookmarkView[] {
  const key = getSessionBookmarkKey(bookmark.reference);
  if (isBookmarked) {
    return bookmarks.filter((item) => getSessionBookmarkKey(item.reference) !== key);
  }
  return [bookmark, ...bookmarks.filter((item) => getSessionBookmarkKey(item.reference) !== key)];
}

function applyBookmarkToggles(
  bookmarks: BookmarkView[],
  toggles: readonly ToggleBookmarkVariables[],
): BookmarkView[] {
  return toggles.reduce(
    (current, { bookmark, isBookmarked }) => toggledBookmarks(current, bookmark, isBookmarked),
    bookmarks,
  );
}

function getPendingBookmarkToggles(queryClient: QueryClient): ToggleBookmarkVariables[] {
  return queryClient
    .getMutationCache()
    .findAll({
      mutationKey: BOOKMARK_TOGGLE_MUTATION_KEY,
      exact: true,
      status: "pending",
    })
    .map((mutation) => mutation.state.variables as ToggleBookmarkVariables);
}

export function useBookmarks() {
  const queryClient = useQueryClient();
  const bookmarksQuery = useQuery({
    queryKey: queryKeys.bookmarks,
    queryFn: async ({ signal }) => {
      try {
        return await fetchBookmarks({ signal });
      } catch (error) {
        if (!signal.aborted) console.error("Failed to load bookmarks:", error);
        throw error;
      }
    },
  });
  const confirmedBookmarks = bookmarksQuery.data?.bookmarks ?? EMPTY_BOOKMARKS;
  const pendingToggles = useMutationState<ToggleBookmarkVariables>({
    filters: {
      mutationKey: BOOKMARK_TOGGLE_MUTATION_KEY,
      exact: true,
      status: "pending",
    },
    select: (mutation) => mutation.state.variables as ToggleBookmarkVariables,
  });
  const bookmarks = useMemo(
    () => applyBookmarkToggles(confirmedBookmarks, pendingToggles),
    [confirmedBookmarks, pendingToggles],
  );

  const setBookmarks = useCallback(
    (next: BookmarkView[]) => {
      queryClient.setQueryData(queryKeys.bookmarks, { bookmarks: next });
    },
    [queryClient],
  );

  const { mutate: mutateBookmark } = useMutation({
    mutationKey: BOOKMARK_TOGGLE_MUTATION_KEY,
    scope: BOOKMARK_WRITE_SCOPE,
    mutationFn: async ({ bookmark, isBookmarked }: ToggleBookmarkVariables) => {
      if (isBookmarked) {
        await deleteBookmark(bookmark.reference);
        return;
      }
      await upsertBookmark(bookmark.reference);
    },
    onMutate: ({ bookmark, isBookmarked }) => {
      logClientEvent(isBookmarked ? "bookmark.delete" : "bookmark.add", {
        agent: bookmark.reference.agentName,
        session: bookmark.reference.sessionId,
      });
    },
    onError: (error) => {
      console.error("Failed to toggle bookmark:", error);
    },
    onSettled: () => {
      if (
        queryClient.isMutating({
          mutationKey: BOOKMARK_TOGGLE_MUTATION_KEY,
          exact: true,
        }) !== 1
      ) {
        return;
      }
      return queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });

  const { mutate: migrateBookmarks } = useMutation({
    scope: BOOKMARK_WRITE_SCOPE,
    mutationFn: importBookmarks,
  });

  useEffect(() => {
    const legacy = loadLegacyBookmarks();
    if (legacy.length === 0) return;
    void queryClient.cancelQueries({ queryKey: queryKeys.bookmarks });
    migrateBookmarks(legacy, {
      onSuccess: (data) => {
        setBookmarks(data.bookmarks);
        clearLegacyBookmarks();
      },
      onError: (error) => console.error("Failed to migrate legacy bookmarks:", error),
    });
  }, [migrateBookmarks, queryClient, setBookmarks]);

  const bookmarkKeySet = useMemo(
    () => new Set(bookmarks.map((bookmark) => getSessionBookmarkKey(bookmark.reference))),
    [bookmarks],
  );

  const isSessionBookmarked = useCallback(
    (agentKey: string, sessionId: string): boolean =>
      bookmarkKeySet.has(getSessionBookmarkKey({ agentName: agentKey, sessionId })),
    [bookmarkKeySet],
  );

  const toggleBookmark = useCallback(
    (bookmark: BookmarkView) => {
      const confirmed =
        queryClient.getQueryData<{ bookmarks: BookmarkView[] }>(queryKeys.bookmarks)?.bookmarks ??
        EMPTY_BOOKMARKS;
      const current = applyBookmarkToggles(confirmed, getPendingBookmarkToggles(queryClient));
      const key = getSessionBookmarkKey(bookmark.reference);
      mutateBookmark({
        bookmark,
        isBookmarked: current.some((item) => getSessionBookmarkKey(item.reference) === key),
      });
    },
    [mutateBookmark, queryClient],
  );

  const toggleSessionBookmark = useCallback(
    (session: SessionHead, agentKey: string) => {
      toggleBookmark(toBookmarkView(session, agentKey));
    },
    [toggleBookmark],
  );

  const refreshBookmarks = bookmarksQuery.refetch;
  const refresh = useCallback(async () => {
    await refreshBookmarks();
  }, [refreshBookmarks]);

  return {
    bookmarkedSessions: bookmarks,
    isSessionBookmarked,
    toggleBookmark,
    toggleSessionBookmark,
    refresh,
  };
}
