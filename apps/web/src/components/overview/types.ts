/**
 * Shared vocabulary for the 统计总览 screen: the metric toggle, the range pills
 * and the two lookups every card needs (a stable scope identity, an agent's
 * display name).
 */
import type { AgentCatalog } from "../../lib/agents";
import type { DashboardScope } from "../../lib/api";
import type { TimeWindowPreset } from "../../lib/time-window";

export type OverviewMetric = "tokens" | "sessions" | "messages";

export const OVERVIEW_METRIC_LABEL: Record<OverviewMetric, string> = {
  tokens: "Token",
  sessions: "会话数",
  messages: "消息数",
};

/** The range pills 3a exposes; a second view of the app's time-window presets. */
export const OVERVIEW_RANGE_PRESETS: readonly { value: TimeWindowPreset; label: string }[] = [
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "all", label: "全部" },
  { value: "custom", label: "自定义" },
];

/** Identity of a scope, so a caller-provided scope can be compared by value. */
export function scopeKey(scope: DashboardScope): string {
  if (scope.kind === "project") return `project:${scope.projectKind}:${scope.projectKey}`;
  if (scope.kind === "agent") return `agent:${scope.agentKey}`;
  return "global";
}

export function agentDisplayName(catalog: AgentCatalog, agentKey: string): string {
  return catalog.displayNameByKey.get(agentKey.toLowerCase()) ?? agentKey;
}
