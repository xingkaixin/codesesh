/**
 * Shared vocabulary for the 统计总览 screen: the range pills and the two lookups
 * every card needs (a stable scope identity, an agent's display name).
 */
import type { AgentCatalog } from "../../lib/agents";
import type { DashboardFilters } from "../../lib/api";
import type { TimeWindowPreset } from "../../lib/time-window";

/** The range pills 3a exposes; a second view of the app's time-window presets. */
export const OVERVIEW_RANGE_PRESETS: readonly { value: TimeWindowPreset; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

/** Identity of a filter set, so a caller-provided one can be compared by value. */
export function scopeKey(filters: DashboardFilters): string {
  const project = filters.project
    ? `project:${filters.project.kind}:${filters.project.key}`
    : "global";
  return filters.agent ? `${project}|agent:${filters.agent}` : project;
}

export function agentDisplayName(catalog: AgentCatalog, agentKey: string): string {
  return catalog.displayNameByKey.get(agentKey.toLowerCase()) ?? agentKey;
}
