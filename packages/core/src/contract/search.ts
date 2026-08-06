import type { SessionReference } from "./session-reference.js";
import type { ReferencedSessionHead } from "./session.js";

export type SearchMatchType =
  | "recent"
  | "title"
  | "user_message"
  | "assistant_reply"
  | "tool_output"
  | "file_path";

export interface SearchResultParent {
  reference: SessionReference;
  title: string;
}

export interface SearchResult extends ReferencedSessionHead {
  snippet: string;
  matchType: SearchMatchType;
  /** Present when the hit is a sub-session AND its parent is in the snapshot.
   *  Renders as 父 › 子 in the results list. */
  parent?: SearchResultParent;
}
