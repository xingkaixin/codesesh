import type { BookmarkRecord, BookmarkView, SessionHead } from "./api";
import {
  assertSessionIdentity,
  getSessionReferenceKey,
  normalizeSessionReference,
  type SessionReference,
} from "@codesesh/core/contract";

const LEGACY_BOOKMARK_STORAGE_KEY = "codesesh:bookmarks:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseReference(value: Record<string, unknown>): SessionReference | null {
  if (
    isRecord(value.reference) &&
    typeof value.reference.agentName === "string" &&
    typeof value.reference.sessionId === "string" &&
    value.reference.agentName.trim() &&
    value.reference.sessionId
  ) {
    return normalizeSessionReference({
      agentName: value.reference.agentName,
      sessionId: value.reference.sessionId,
    });
  }

  if (
    typeof value.agentKey !== "string" ||
    typeof value.sessionId !== "string" ||
    !value.agentKey.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  return normalizeSessionReference({
    agentName: value.agentKey,
    sessionId: value.sessionId,
  });
}

function parseLegacyBookmark(value: unknown): BookmarkRecord | null {
  if (!isRecord(value)) return null;
  const reference = parseReference(value);
  if (!reference) return null;

  const timestamp = value.bookmarkedAt ?? value.bookmarked_at;
  if (timestamp != null && (typeof timestamp !== "number" || !Number.isFinite(timestamp))) {
    return null;
  }
  return {
    reference,
    bookmarkedAt: typeof timestamp === "number" ? timestamp : Date.now(),
  };
}

export function getSessionBookmarkKey(reference: SessionReference): string {
  return getSessionReferenceKey(reference);
}

export function toBookmarkView(session: SessionHead, agentKey: string): BookmarkView {
  assertSessionIdentity(session, agentKey);
  return {
    reference: session.reference,
    session,
    availability: "available",
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
      .toSorted((left, right) => right.bookmarkedAt - left.bookmarkedAt);
  } catch {
    return [];
  }
}

export function clearLegacyBookmarks(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_BOOKMARK_STORAGE_KEY);
}
