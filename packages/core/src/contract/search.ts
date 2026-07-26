import type { ReferencedSessionHead } from "./session.js";

export type SearchMatchType =
  | "recent"
  | "title"
  | "user_message"
  | "assistant_reply"
  | "tool_output"
  | "file_path";

export interface SearchResult extends ReferencedSessionHead {
  snippet: string;
  matchType: SearchMatchType;
}
