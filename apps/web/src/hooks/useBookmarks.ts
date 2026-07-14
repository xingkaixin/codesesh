import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BookmarkedSessionSnapshot,
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
  toBookmarkedSessionSnapshot,
} from "../lib/bookmarks";

/**
 * Owns bookmark state: initial fetch, snapshot-merge sync as sessions change,
 * legacy migration, and optimistic add/remove toggles. Takes the current
 * sessions so bookmark snapshots stay in sync with live session data.
 */
export function useBookmarks(sessions: SessionHead[]) {
  const [bookmarks, setBookmarks] = useState<BookmarkedSessionSnapshot[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchBookmarks();
      setBookmarks(data.bookmarks);
    } catch (err) {
      console.error("Failed to load bookmarks:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchBookmarks()
      .then((data) => {
        if (!cancelled) setBookmarks(data.bookmarks);
      })
      .catch((err) => {
        console.error("Failed to load bookmarks:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setBookmarks((prev) => {
      const next = mergeBookmarksWithSessions(prev, sessions);
      if (next === prev) return prev;
      void importBookmarks(
        next.map(({ bookmarked_at: _bookmarkedAt, ...bookmark }) => bookmark),
      ).catch((error) => {
        if (!cancelled) {
          console.error("Failed to sync bookmark snapshots:", error);
        }
      });
      return next;
    });

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const legacy = loadLegacyBookmarks();
      if (legacy.length === 0) return;

      try {
        const data = await importBookmarks(
          legacy.map(({ bookmarked_at: _bookmarkedAt, ...bookmark }) => bookmark),
        );
        if (cancelled) return;
        setBookmarks(data.bookmarks);
        clearLegacyBookmarks();
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to migrate legacy bookmarks:", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const bookmarkKeySet = useMemo(
    () =>
      new Set(
        bookmarks.map((bookmark) => getSessionBookmarkKey(bookmark.agentKey, bookmark.sessionId)),
      ),
    [bookmarks],
  );

  const isSessionBookmarked = useCallback(
    (agentKey: string, sessionId: string): boolean =>
      bookmarkKeySet.has(getSessionBookmarkKey(agentKey, sessionId)),
    [bookmarkKeySet],
  );

  const toggleBookmark = useCallback(
    (snapshot: BookmarkedSessionSnapshot) => {
      const key = getSessionBookmarkKey(snapshot.agentKey, snapshot.sessionId);
      const exists = bookmarkKeySet.has(key);
      const previous = bookmarks;
      const next = exists
        ? previous.filter(
            (bookmark) => getSessionBookmarkKey(bookmark.agentKey, bookmark.sessionId) !== key,
          )
        : [...previous, snapshot].toSorted((a, b) => {
            const aTime = a.time_updated ?? a.time_created;
            const bTime = b.time_updated ?? b.time_created;
            return bTime - aTime;
          });

      setBookmarks(next);
      logClientEvent(exists ? "bookmark.delete" : "bookmark.add", {
        agent: snapshot.agentKey,
        session: snapshot.sessionId,
      });

      void (
        exists
          ? deleteBookmark(snapshot.agentKey, snapshot.sessionId)
          : upsertBookmark({
              agentKey: snapshot.agentKey,
              sessionId: snapshot.sessionId,
              fullPath: snapshot.fullPath,
              title: snapshot.title,
              directory: snapshot.directory,
              time_created: snapshot.time_created,
              time_updated: snapshot.time_updated,
              stats: snapshot.stats,
            })
      ).catch((error) => {
        console.error("Failed to toggle bookmark:", error);
        setBookmarks(previous);
      });
    },
    [bookmarkKeySet, bookmarks],
  );

  const toggleSessionBookmark = useCallback(
    (session: SessionHead, agentKey: string) => {
      toggleBookmark(toBookmarkedSessionSnapshot(session, agentKey));
    },
    [toggleBookmark],
  );

  const bookmarkedSessions = useMemo(
    () =>
      bookmarks.toSorted(
        (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
      ),
    [bookmarks],
  );

  return {
    bookmarkedSessions,
    isSessionBookmarked,
    toggleBookmark,
    toggleSessionBookmark,
    refresh,
  };
}
