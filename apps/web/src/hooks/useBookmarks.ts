import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import {
  type BookmarkRecord,
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
  mergeBookmarksWithSessions,
  toBookmarkRecord,
} from "../lib/bookmarks";
import { queryKeys } from "../lib/query-keys";

interface ToggleBookmarkVariables {
  snapshot: BookmarkRecord;
  isBookmarked: boolean;
}

const EMPTY_BOOKMARKS: BookmarkRecord[] = [];

function withoutBookmarkTimestamp(bookmarks: BookmarkRecord[]) {
  return bookmarks.map(({ bookmarkedAt: _bookmarkedAt, ...bookmark }) => bookmark);
}

function toggledBookmarks(
  bookmarks: BookmarkRecord[],
  snapshot: BookmarkRecord,
  isBookmarked: boolean,
): BookmarkRecord[] {
  const key = getSessionBookmarkKey(snapshot.reference);
  if (isBookmarked) {
    return bookmarks.filter((bookmark) => getSessionBookmarkKey(bookmark.reference) !== key);
  }
  return [...bookmarks, snapshot].toSorted((a, b) => {
    const aTime = a.session.time_updated ?? a.session.time_created;
    const bTime = b.session.time_updated ?? b.session.time_created;
    return bTime - aTime;
  });
}

function sameBookmarks(left: BookmarkRecord[], right: BookmarkRecord[]): boolean {
  return left.length === right.length && left.every((bookmark, index) => bookmark === right[index]);
}

export function useBookmarks(sessions: SessionHead[]) {
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
    (next: BookmarkRecord[]) => {
      queryClient.setQueryData(queryKeys.bookmarks, { bookmarks: next });
    },
    [queryClient],
  );

  const { mutate: mutateBookmark } = useMutation({
    mutationFn: async ({ snapshot, isBookmarked }: ToggleBookmarkVariables) => {
      if (isBookmarked) {
        await deleteBookmark(snapshot.reference);
        return;
      }
      const { bookmarkedAt: _bookmarkedAt, ...bookmark } = snapshot;
      await upsertBookmark(bookmark);
    },
    onMutate: async ({ snapshot, isBookmarked }) => {
      const cancellation = queryClient.cancelQueries({ queryKey: queryKeys.bookmarks });
      const previous = queryClient.getQueryData<{ bookmarks: BookmarkRecord[] }>(
        queryKeys.bookmarks,
      );
      setBookmarks(toggledBookmarks(previous?.bookmarks ?? [], snapshot, isBookmarked));
      logClientEvent(isBookmarked ? "bookmark.delete" : "bookmark.add", {
        agent: snapshot.reference.agentName,
        session: snapshot.reference.sessionId,
      });
      await cancellation;
      return previous;
    },
    onError: (error, _variables, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.bookmarks, previous);
      console.error("Failed to toggle bookmark:", error);
    },
  });

  const { mutate: syncBookmarks } = useMutation({
    mutationFn: (bookmarks: Omit<BookmarkRecord, "bookmarkedAt">[]) => importBookmarks(bookmarks),
  });
  const { mutate: migrateBookmarks } = useMutation({
    mutationFn: (bookmarks: Omit<BookmarkRecord, "bookmarkedAt">[]) => importBookmarks(bookmarks),
  });

  useEffect(() => {
    const next = mergeBookmarksWithSessions(bookmarks, sessions);
    if (next === bookmarks || sameBookmarks(next, bookmarks)) return;
    setBookmarks(next);
    syncBookmarks(withoutBookmarkTimestamp(next), {
      onError: (error) => console.error("Failed to sync bookmark snapshots:", error),
    });
  }, [bookmarks, sessions, setBookmarks, syncBookmarks]);

  useEffect(() => {
    const legacy = loadLegacyBookmarks();
    if (legacy.length === 0) return;
    void queryClient.cancelQueries({ queryKey: queryKeys.bookmarks });
    migrateBookmarks(withoutBookmarkTimestamp(legacy), {
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
    (snapshot: BookmarkRecord) => {
      const key = getSessionBookmarkKey(snapshot.reference);
      mutateBookmark({ snapshot, isBookmarked: bookmarkKeySet.has(key) });
    },
    [bookmarkKeySet, mutateBookmark],
  );

  const toggleSessionBookmark = useCallback(
    (session: SessionHead, agentKey: string) => {
      toggleBookmark(toBookmarkRecord(session, agentKey));
    },
    [toggleBookmark],
  );

  const bookmarkedSessions = useMemo(
    () =>
      bookmarks.toSorted(
        (a, b) =>
          (b.session.time_updated ?? b.session.time_created) -
          (a.session.time_updated ?? a.session.time_created),
      ),
    [bookmarks],
  );

  const refreshBookmarks = bookmarksQuery.refetch;
  const refresh = useCallback(async () => {
    await refreshBookmarks();
  }, [refreshBookmarks]);

  return {
    bookmarkedSessions,
    isSessionBookmarked,
    toggleBookmark,
    toggleSessionBookmark,
    refresh,
  };
}
