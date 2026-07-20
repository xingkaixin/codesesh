import type { AppConfig, SearchRequestOptions } from "./api";

type TimeWindow = AppConfig["window"];

function normalizeWindow(window: TimeWindow) {
  return {
    days: window.days,
    from: window.from,
    to: window.to,
  };
}

export const queryKeys = {
  bookmarks: ["bookmarks"] as const,
  config: ["config"] as const,
  dashboard: (
    window: TimeWindow,
    filters: {
      agent?: string;
      projectKind?: string;
      projectKey?: string;
    },
  ) => ["dashboard", normalizeWindow(window), filters] as const,
  search: (query: string, options: SearchRequestOptions) => ["search", query, options] as const,
  sessionDetail: (agent: string, sessionSlug: string) =>
    ["session-detail", agent, sessionSlug] as const,
  sessionSnapshots: ["session-snapshot"] as const,
  sessionSnapshot: (window: TimeWindow) => ["session-snapshot", normalizeWindow(window)] as const,
  sessionSnapshotAggregates: (window: TimeWindow) =>
    ["session-snapshot-aggregates", normalizeWindow(window)] as const,
} as const;
