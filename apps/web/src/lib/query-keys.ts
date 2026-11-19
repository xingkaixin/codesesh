import type { AppConfig, ProjectIdentityRef } from "@codesesh/contract";
import type { DashboardFilters, ProjectSort, SearchRequestOptions } from "./api";

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
    ...(filters.sourceNodeId ? { sourceNodeId: filters.sourceNodeId } : {}),
    timeZone: filters.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export const queryKeys = {
  nodeSessions: ["node-sessions"] as const,
  bookmarks: ["bookmarks"] as const,
  config: ["config"] as const,
  dashboards: ["dashboard"] as const,
  dashboard: (window: TimeWindow, filters: DashboardFilters) =>
    ["dashboard", normalizeWindow(window), normalizeDashboardFilters(filters)] as const,
  agentCatalogs: ["agent-catalog"] as const,
  agentCatalog: (window: TimeWindow) => ["agent-catalog", normalizeWindow(window)] as const,
  projects: ["projects"] as const,
  projectWindow: (window: TimeWindow) => ["projects", normalizeWindow(window)] as const,
  projectPage: (window: TimeWindow, cursor?: string, sourceNodeId?: string, sort?: ProjectSort) => {
    const normalizedSort = sort && sort !== "latest" ? sort : undefined;
    if (normalizedSort) {
      return [
        "projects",
        normalizeWindow(window),
        "page",
        cursor ?? null,
        sourceNodeId ?? null,
        normalizedSort,
      ] as const;
    }
    return sourceNodeId
      ? (["projects", normalizeWindow(window), "page", cursor ?? null, sourceNodeId] as const)
      : (["projects", normalizeWindow(window), "page", cursor ?? null] as const);
  },
  projectDetail: (window: TimeWindow, project: ProjectIdentityRef, sourceNodeId?: string) =>
    ["projects", normalizeWindow(window), "detail", project, sourceNodeId ?? null] as const,
  search: (query: string, options: SearchRequestOptions) => ["search", query, options] as const,
  searches: ["search"] as const,
  sessionDetails: ["session-detail"] as const,
  sessionDetail: (agent: string, sessionId: string, sourceNodeId?: string) =>
    sourceNodeId && sourceNodeId !== "local"
      ? (["session-detail", agent, sessionId, sourceNodeId] as const)
      : (["session-detail", agent, sessionId] as const),
  sessionProjections: ["session-projection"] as const,
  sessionProjection: (window: TimeWindow) =>
    ["session-projection", normalizeWindow(window)] as const,
  pricing: ["pricing"] as const,
  pricingOverrides: ["pricing", "overrides"] as const,
  pricingUnmatcheds: ["pricing", "unmatched"] as const,
  pricingUnmatched: (from?: number, to?: number, days?: number) =>
    ["pricing", "unmatched", from ?? null, to ?? null, days ?? null] as const,
  pricingModelLists: ["pricing-models"] as const,
  pricingModels: (q: string, limit: number) => ["pricing-models", q, limit] as const,
} as const;
