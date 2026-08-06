import type { AppConfig, DashboardScope, SearchRequestOptions } from "./api";

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
  dashboards: ["dashboard"] as const,
  dashboard: (window: TimeWindow, scope: DashboardScope) =>
    ["dashboard", normalizeWindow(window), scope] as const,
  search: (query: string, options: SearchRequestOptions) => ["search", query, options] as const,
  searches: ["search"] as const,
  sessionDetails: ["session-detail"] as const,
  sessionDetail: (agent: string, sessionId: string) =>
    ["session-detail", agent, sessionId] as const,
  sessionSnapshots: ["session-snapshot"] as const,
  sessionSnapshot: (window: TimeWindow) => ["session-snapshot", normalizeWindow(window)] as const,
  sessionSnapshotAggregateQueries: ["session-snapshot-aggregates"] as const,
  sessionSnapshotAggregates: (window: TimeWindow) =>
    ["session-snapshot-aggregates", normalizeWindow(window)] as const,
} as const;
