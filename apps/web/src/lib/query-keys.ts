import type { AppConfig, DashboardFilters, SearchRequestOptions } from "./api";

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
  dashboard: (window: TimeWindow, filters: DashboardFilters) =>
    ["dashboard", normalizeWindow(window), filters] as const,
  projects: ["projects"] as const,
  project: (window: TimeWindow) => ["projects", normalizeWindow(window)] as const,
  search: (query: string, options: SearchRequestOptions) => ["search", query, options] as const,
  searches: ["search"] as const,
  sessionDetails: ["session-detail"] as const,
  sessionDetail: (agent: string, sessionId: string) =>
    ["session-detail", agent, sessionId] as const,
  sessionProjections: ["session-projection"] as const,
  sessionProjection: (window: TimeWindow) =>
    ["session-projection", normalizeWindow(window)] as const,
  sessionAggregates: ["session-aggregates"] as const,
  sessionAggregate: (window: TimeWindow) =>
    ["session-aggregates", normalizeWindow(window)] as const,
} as const;
