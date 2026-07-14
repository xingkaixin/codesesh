import type { SessionStats } from "./session.js";

export interface BookmarkRecord {
  agentKey: string;
  sessionId: string;
  fullPath: string;
  title: string;
  display_title?: string;
  directory: string;
  time_created: number;
  time_updated?: number;
  stats: SessionStats;
  bookmarked_at: number;
}
