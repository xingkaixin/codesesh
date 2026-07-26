import type { ReferencedSessionHead } from "./session.js";

export interface BookmarkRecord extends ReferencedSessionHead {
  bookmarkedAt: number;
}
