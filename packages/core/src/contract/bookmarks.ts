import type { PublicSessionHead } from "./session.js";
import type { SessionReference } from "./session-reference.js";

export interface BookmarkRecord {
  reference: SessionReference;
  bookmarkedAt: number;
}

export interface AvailableBookmarkView extends BookmarkRecord {
  availability: "available";
  session: PublicSessionHead;
}

export interface UnavailableBookmarkView extends BookmarkRecord {
  availability: "session-unavailable" | "agent-unavailable";
  display_title?: string;
}

export type BookmarkView = AvailableBookmarkView | UnavailableBookmarkView;
