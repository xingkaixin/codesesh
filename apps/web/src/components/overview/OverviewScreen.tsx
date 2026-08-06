/**
 * 统计总览 (screen 3a). One component tree, one dashboard request: project and
 * agent are independent filters on that request, so the global view and a
 * project's view share the same cards and the same loading path. A project
 * dashboard IS the global dashboard with `project` set.
 *
 * Which project is covered comes from navigation and is fixed for the mount.
 * The agent filter is self-managed for the global view; the project page passes
 * `onAgentChange` to drive it from the picker that also filters its timeline.
 *
 * The time window is NOT owned here — the range pills report upwards so the
 * app's time-window controller stays the single source of truth.
 */
import { useState } from "react";

import type { AgentCatalog } from "../../lib/agents";
import type { AppConfig, DashboardFilters } from "../../lib/api";
import type { TimeWindowPreset } from "../../lib/time-window";
import { useDashboard } from "../../hooks/useDashboard";
import { OverviewAgentDistribution } from "./overview-agent-distribution";
import { OverviewCostBreakdown } from "./overview-cost-breakdown";
import { OverviewFilterBar } from "./overview-filter-bar";
import { OverviewKpiGrid } from "./overview-kpi-grid";
import { OverviewProjectRank } from "./overview-project-rank";
import { OverviewSkeleton } from "./overview-skeleton";
import { OverviewUsageChart } from "./overview-usage-chart";
import type { OverviewMetric } from "./types";

export function OverviewScreen({
  project,
  agent: controlledAgent,
  onAgentChange,
  window,
  agentCatalog,
  rangePreset,
  onRangeChange,
}: {
  project?: DashboardFilters["project"];
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  window: AppConfig["window"] | null;
  agentCatalog: AgentCatalog;
  rangePreset: TimeWindowPreset;
  onRangeChange: (preset: TimeWindowPreset) => void;
}) {
  const [ownAgent, setOwnAgent] = useState<string | undefined>(undefined);
  const agent = onAgentChange ? controlledAgent : ownAgent;

  const [metric, setMetric] = useState<OverviewMetric>("tokens");
  const [hoverDayIndex, setHoverDayIndex] = useState<number | null>(null);
  const filters: DashboardFilters = { project, agent };
  const { dashboard, error } = useDashboard(window, filters);

  return (
    <div data-testid="dashboard" className="mx-auto max-w-6xl space-y-4">
      <OverviewFilterBar
        agent={agent}
        onAgentChange={onAgentChange ? undefined : setOwnAgent}
        agentCatalog={agentCatalog}
        scopeCounts={dashboard?.scopeCounts}
        rangePreset={rangePreset}
        onRangeChange={onRangeChange}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-4 text-sm text-[var(--console-error)]"
        >
          {error}
        </p>
      ) : dashboard ? (
        <>
          <OverviewKpiGrid totals={dashboard.totals} rangeDays={dashboard.window.days} />
          <OverviewUsageChart
            daily={dashboard.dailyActivity}
            metric={metric}
            onMetricChange={setMetric}
            hoverDayIndex={hoverDayIndex}
            onHoverDayChange={setHoverDayIndex}
          />
          <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr]">
            <OverviewProjectRank
              filters={filters}
              projects={dashboard.perProject}
              perAgent={dashboard.perAgent}
              rollup={dashboard.projectRollup}
              scopeCounts={dashboard.scopeCounts}
              agentCatalog={agentCatalog}
            />
            <div className="grid content-start gap-4">
              {/* Inside a project the ranking card already ranks agents. */}
              {project ? null : <OverviewAgentDistribution perAgent={dashboard.perAgent} />}
              <OverviewCostBreakdown
                modelCost={dashboard.modelCost}
                modelDistribution={dashboard.modelDistribution}
                totals={dashboard.totals}
              />
            </div>
          </div>
        </>
      ) : (
        <OverviewSkeleton />
      )}
    </div>
  );
}
