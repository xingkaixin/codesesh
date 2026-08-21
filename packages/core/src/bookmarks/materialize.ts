import type {
  BookmarkRecord,
  BookmarkView,
  ReferencedSessionHead,
  SessionHead,
  SessionReference,
} from "../contract/index.js";
import {
  assertSessionIdentity,
  getSessionReferenceKey,
  normalizeSessionReference,
} from "../contract/index.js";

export interface BookmarkMaterializationOptions {
  liveSessionsByReference: ReadonlyMap<string, SessionHead>;
  knownAgentNames: ReadonlySet<string>;
  resolveCachedSessions?: (
    references: readonly SessionReference[],
  ) => readonly ReferencedSessionHead[];
}

function canonicalSession(reference: SessionReference, session: SessionHead): SessionHead {
  const normalized = normalizeSessionReference(reference);
  assertSessionIdentity(session, normalized.agentName);
  if (session.reference.sessionId !== normalized.sessionId) {
    throw new Error("Session identity fields disagree");
  }
  return session;
}

function compareDescending(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function getBookmarkViewTime(bookmark: BookmarkView): number {
  return bookmark.availability === "available"
    ? (bookmark.session.time_updated ?? bookmark.session.time_created)
    : bookmark.bookmarkedAt;
}

export function compareBookmarkViews(left: BookmarkView, right: BookmarkView): number {
  return (
    compareDescending(getBookmarkViewTime(left), getBookmarkViewTime(right)) ||
    compareDescending(left.bookmarkedAt, right.bookmarkedAt) ||
    getSessionReferenceKey(left.reference).localeCompare(getSessionReferenceKey(right.reference))
  );
}

export function materializeBookmarkViews(
  bookmarks: readonly BookmarkRecord[],
  options: BookmarkMaterializationOptions,
): BookmarkView[] {
  const liveByKey = new Map<string, SessionHead>();
  const missingByKey = new Map<string, SessionReference>();
  const normalizedBookmarks = bookmarks.map((bookmark) => {
    const reference = normalizeSessionReference(bookmark.reference);
    return {
      bookmark: { reference, bookmarkedAt: bookmark.bookmarkedAt },
      key: getSessionReferenceKey(reference),
    };
  });

  for (const { bookmark, key } of normalizedBookmarks) {
    const { reference } = bookmark;
    const live = options.liveSessionsByReference.get(key);
    if (live) liveByKey.set(key, canonicalSession(reference, live));
    else if (!missingByKey.has(key)) missingByKey.set(key, reference);
  }

  const cachedByKey = new Map<string, SessionHead>();
  if (missingByKey.size > 0 && options.resolveCachedSessions) {
    for (const cached of options.resolveCachedSessions([...missingByKey.values()])) {
      const reference = normalizeSessionReference(cached.reference);
      const key = getSessionReferenceKey(reference);
      if (missingByKey.has(key) && !cachedByKey.has(key)) {
        cachedByKey.set(key, canonicalSession(reference, cached.session));
      }
    }
  }

  const views = normalizedBookmarks.map(({ bookmark, key }): BookmarkView => {
    const session = liveByKey.get(key) ?? cachedByKey.get(key);
    if (session) return { ...bookmark, availability: "available", session };

    return {
      ...bookmark,
      availability: options.knownAgentNames.has(bookmark.reference.agentName)
        ? "session-unavailable"
        : "agent-unavailable",
    };
  });

  return views.sort(compareBookmarkViews);
}
