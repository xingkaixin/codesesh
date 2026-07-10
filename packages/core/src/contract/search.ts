import type { SessionHead } from "./session.js";

export type SearchMatchType =
  | "recent"
  | "title"
  | "user_message"
  | "assistant_reply"
  | "tool_output"
  | "file_path";

export interface SearchResult {
  agentName: string;
  session: SessionHead;
  snippet: string;
  matchType: SearchMatchType;
}
