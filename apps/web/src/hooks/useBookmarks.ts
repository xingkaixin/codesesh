import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

function toggledBookmarks(
  bookmarks: BookmarkView[],
  bookmark: BookmarkView,
  isBookmarked: boolean,
): BookmarkView[] {
  const key = getSessionBookmarkKey(bookmark.reference);
  if (isBookmarked) {
    return bookmarks.filter((item) => getSessionBookmarkKey(item.reference) !== key);
  }
  return [bookmark, ...bookmarks];
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
  const bookmarks = bookmarksQuery.data?.bookmarks ?? EMPTY_BOOKMARKS;

  const setBookmarks = useCallback(
    (next: BookmarkView[]) => {
      queryClient.setQueryData(queryKeys.bookmarks, { bookmarks: next });
    },
    [queryClient],
  );

  const { mutate: mutateBookmark } = useMutation({
    mutationFn: async ({ bookmark, isBookmarked }: ToggleBookmarkVariables) => {
      if (isBookmarked) {
        await deleteBookmark(bookmark.reference);
        return;
      }
      await upsertBookmark(bookmark.reference);
    },
    onMutate: async ({ bookmark, isBookmarked }) => {
      const cancellation = queryClient.cancelQueries({ queryKey: queryKeys.bookmarks });
      const previous = queryClient.getQueryData<{ bookmarks: BookmarkView[] }>(queryKeys.bookmarks);
      setBookmarks(toggledBookmarks(previous?.bookmarks ?? [], bookmark, isBookmarked));
      logClientEvent(isBookmarked ? "bookmark.delete" : "bookmark.add", {
        agent: bookmark.reference.agentName,
        session: bookmark.reference.sessionId,
      });
      await cancellation;
      return previous;
    },
    onError: (error, _variables, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.bookmarks, previous);
      console.error("Failed to toggle bookmark:", error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks }),
  });

  const { mutate: migrateBookmarks } = useMutation({
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
      const key = getSessionBookmarkKey(bookmark.reference);
      mutateBookmark({ bookmark, isBookmarked: bookmarkKeySet.has(key) });
    },
    [bookmarkKeySet, mutateBookmark],
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
