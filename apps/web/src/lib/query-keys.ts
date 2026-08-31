import type { AppConfig, DashboardFilters, ProjectIdentityRef, SearchRequestOptions } from "./api";

type TimeWindow = AppConfig["window"];

function normalizeWindow(window: TimeWindow) {
  return {
    days: window.days,
    from: window.from,
    to: window.to,
  };
}

function normalizeDashboardFilters(filters: DashboardFilters): DashboardFilters {
  return {
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.agent ? { agent: filters.agent } : {}),
  };
}

export const queryKeys = {
  bookmarks: ["bookmarks"] as const,
  config: ["config"] as const,
  dashboards: ["dashboard"] as const,
  dashboard: (window: TimeWindow, filters: DashboardFilters) =>
    ["dashboard", normalizeWindow(window), normalizeDashboardFilters(filters)] as const,
  agentCatalogs: ["agent-catalog"] as const,
  agentCatalog: (window: TimeWindow) => ["agent-catalog", normalizeWindow(window)] as const,
  projects: ["projects"] as const,
  projectWindow: (window: TimeWindow) => ["projects", normalizeWindow(window)] as const,
  projectPage: (window: TimeWindow, cursor?: string) =>
    ["projects", normalizeWindow(window), "page", cursor ?? null] as const,
  projectDetail: (window: TimeWindow, project: ProjectIdentityRef) =>
    ["projects", normalizeWindow(window), "detail", project] as const,
  search: (query: string, options: SearchRequestOptions) => ["search", query, options] as const,
  searches: ["search"] as const,
  sessionDetails: ["session-detail"] as const,
  sessionDetail: (agent: string, sessionId: string) =>
    ["session-detail", agent, sessionId] as const,
  sessionProjections: ["session-projection"] as const,
  sessionProjection: (window: TimeWindow) =>
    ["session-projection", normalizeWindow(window)] as const,
} as const;
