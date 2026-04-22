import type { BookmarkedSessionSnapshot, SessionHead } from "./api";

const LEGACY_BOOKMARK_STORAGE_KEY = "codesesh:bookmarks:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStats(value: unknown): value is SessionHead["stats"] {
  if (!isRecord(value)) return false;
  return (
    typeof value.message_count === "number" &&
    typeof value.total_input_tokens === "number" &&
    typeof value.total_output_tokens === "number" &&
    typeof value.total_cost === "number" &&
    (value.total_tokens == null || typeof value.total_tokens === "number")
  );
}

function isBookmarkedSessionSnapshot(value: unknown): value is BookmarkedSessionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.agentKey === "string" &&
    typeof value.fullPath === "string" &&
    typeof value.title === "string" &&
    typeof value.directory === "string" &&
    typeof value.time_created === "number" &&
    (value.time_updated == null || typeof value.time_updated === "number") &&
    (value.bookmarked_at == null || typeof value.bookmarked_at === "number") &&
    isStats(value.stats)
  );
}

export function getSessionBookmarkKey(agentKey: string, sessionId: string): string {
  return `${agentKey}:${sessionId}`;
}

export function toBookmarkedSessionSnapshot(
  session: SessionHead,
  agentKey: string,
): BookmarkedSessionSnapshot {
  return {
    sessionId: session.id,
    agentKey,
    fullPath: session.slug,
    title: session.title,
    directory: session.directory,
    time_created: session.time_created,
    time_updated: session.time_updated,
    stats: session.stats,
    bookmarked_at: Date.now(),
  };
}

export function loadLegacyBookmarks(): BookmarkedSessionSnapshot[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(LEGACY_BOOKMARK_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBookmarkedSessionSnapshot).toSorted(sortBookmarkedSessions);
  } catch {
    return [];
  }
}

export function clearLegacyBookmarks(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_BOOKMARK_STORAGE_KEY);
}

export function sortBookmarkedSessions(
  a: BookmarkedSessionSnapshot,
  b: BookmarkedSessionSnapshot,
): number {
  const aTime = a.time_updated ?? a.time_created;
  const bTime = b.time_updated ?? b.time_created;
  return bTime - aTime;
}

export function mergeBookmarksWithSessions(
  bookmarks: BookmarkedSessionSnapshot[],
  sessions: SessionHead[],
): BookmarkedSessionSnapshot[] {
  if (bookmarks.length === 0 || sessions.length === 0) return bookmarks;

  const liveSnapshots = new Map(
    sessions.map((session) => {
      const agentKey = session.slug.split("/")[0]?.toLowerCase() ?? "unknown";
      const snapshot = toBookmarkedSessionSnapshot(session, agentKey);
      return [getSessionBookmarkKey(snapshot.agentKey, snapshot.sessionId), snapshot] as const;
    }),
  );

  let changed = false;
  const next = bookmarks.map((bookmark) => {
    const live = liveSnapshots.get(getSessionBookmarkKey(bookmark.agentKey, bookmark.sessionId));
    if (!live) return bookmark;
    const same =
      live.fullPath === bookmark.fullPath &&
      live.title === bookmark.title &&
      live.directory === bookmark.directory &&
      live.time_created === bookmark.time_created &&
      live.time_updated === bookmark.time_updated &&
      live.stats.message_count === bookmark.stats.message_count &&
      live.stats.total_input_tokens === bookmark.stats.total_input_tokens &&
      live.stats.total_output_tokens === bookmark.stats.total_output_tokens &&
      live.stats.total_cost === bookmark.stats.total_cost &&
      live.stats.total_tokens === bookmark.stats.total_tokens;
    if (same) return bookmark;
    changed = true;
    return {
      ...live,
      bookmarked_at: bookmark.bookmarked_at,
    };
  });

  return changed ? next.toSorted(sortBookmarkedSessions) : bookmarks;
}
