import type { BookmarkRecord, SessionHead } from "./api";
import {
  formatSessionReference,
  getSessionAgentKey,
  normalizeSessionReference,
  type SessionReference,
} from "@codesesh/core/contract";

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

function parseLegacyBookmark(value: unknown): BookmarkRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sessionId === "string" &&
    typeof value.agentKey === "string" &&
    typeof value.fullPath === "string" &&
    Boolean(value.sessionId) &&
    Boolean(value.agentKey.trim()) &&
    typeof value.title === "string" &&
    typeof value.directory === "string" &&
    typeof value.time_created === "number" &&
    (value.time_updated == null || typeof value.time_updated === "number") &&
    (value.bookmarked_at == null || typeof value.bookmarked_at === "number") &&
    isStats(value.stats)
  ) {
    const reference = normalizeSessionReference({
      agentName: value.agentKey,
      sessionId: value.sessionId,
    });
    return {
      reference,
      session: {
        id: reference.sessionId,
        slug: formatSessionReference(reference),
        title: value.title,
        display_title: typeof value.display_title === "string" ? value.display_title : undefined,
        directory: value.directory,
        time_created: value.time_created,
        time_updated: typeof value.time_updated === "number" ? value.time_updated : undefined,
        stats: value.stats,
      },
      bookmarkedAt: typeof value.bookmarked_at === "number" ? value.bookmarked_at : Date.now(),
    };
  }
  return null;
}

export function getSessionBookmarkKey(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return JSON.stringify([normalized.agentName, normalized.sessionId]);
}

export function toBookmarkRecord(session: SessionHead, agentKey: string): BookmarkRecord {
  const reference = normalizeSessionReference({
    agentName: agentKey,
    sessionId: session.id,
  });
  return {
    reference,
    session: {
      ...session,
      id: reference.sessionId,
      slug: formatSessionReference(reference),
    },
    bookmarkedAt: Date.now(),
  };
}

export function loadLegacyBookmarks(): BookmarkRecord[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(LEGACY_BOOKMARK_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseLegacyBookmark)
      .filter((bookmark): bookmark is BookmarkRecord => bookmark !== null)
      .toSorted(sortBookmarks);
  } catch {
    return [];
  }
}

export function clearLegacyBookmarks(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_BOOKMARK_STORAGE_KEY);
}

export function sortBookmarks(a: BookmarkRecord, b: BookmarkRecord): number {
  const aTime = a.session.time_updated ?? a.session.time_created;
  const bTime = b.session.time_updated ?? b.session.time_created;
  return bTime - aTime;
}

export function mergeBookmarksWithSessions(
  bookmarks: BookmarkRecord[],
  sessions: SessionHead[],
): BookmarkRecord[] {
  if (bookmarks.length === 0 || sessions.length === 0) return bookmarks;

  const liveSnapshots = new Map(
    sessions.map((session) => {
      const agentKey = getSessionAgentKey(session);
      const snapshot = toBookmarkRecord(session, agentKey);
      return [getSessionBookmarkKey(snapshot.reference), snapshot] as const;
    }),
  );

  let changed = false;
  const next = bookmarks.map((bookmark) => {
    const live = liveSnapshots.get(getSessionBookmarkKey(bookmark.reference));
    if (!live) return bookmark;
    const same =
      live.session.slug === bookmark.session.slug &&
      live.session.title === bookmark.session.title &&
      live.session.directory === bookmark.session.directory &&
      live.session.time_created === bookmark.session.time_created &&
      live.session.time_updated === bookmark.session.time_updated &&
      live.session.stats.message_count === bookmark.session.stats.message_count &&
      live.session.stats.total_input_tokens === bookmark.session.stats.total_input_tokens &&
      live.session.stats.total_output_tokens === bookmark.session.stats.total_output_tokens &&
      live.session.stats.total_cost === bookmark.session.stats.total_cost &&
      live.session.stats.total_tokens === bookmark.session.stats.total_tokens;
    if (same) return bookmark;
    changed = true;
    return {
      ...live,
      bookmarkedAt: bookmark.bookmarkedAt,
    };
  });

  return changed ? next.toSorted(sortBookmarks) : bookmarks;
}
