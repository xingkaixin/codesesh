/**
 * 统计总览 (screen 3a). One component tree, one dashboard request: the scope
 * (global / project / agent) is just a parameter of that request, so all three
 * views share the same cards and the same loading path.
 *
 * The time window is NOT owned here — the range pills report upwards so the
 * app's time-window controller stays the single source of truth.
 */
import { useState } from "react";

import type { AgentCatalog } from "../../lib/agents";
import type { ApiProjectGroup, AppConfig, DashboardScope } from "../../lib/api";
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
  scope: initialScope,
  window,
  projects,
  agentCatalog,
  rangePreset,
  onRangeChange,
}: {
  scope: DashboardScope;
  window: AppConfig["window"] | null;
  projects: ApiProjectGroup[];
  agentCatalog: AgentCatalog;
  rangePreset: TimeWindowPreset;
  onRangeChange: (preset: TimeWindowPreset) => void;
}) {
  const [scope, setScope] = useState<DashboardScope>(initialScope);
  const [metric, setMetric] = useState<OverviewMetric>("tokens");
  const [hoverDayIndex, setHoverDayIndex] = useState<number | null>(null);
  const { dashboard, error } = useDashboard(window, scope);

  return (
    <div data-testid="dashboard" className="mx-auto max-w-6xl space-y-4">
      <OverviewFilterBar
        scope={scope}
        onScopeChange={setScope}
        projects={projects}
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
              scope={scope}
              projects={dashboard.perProject}
              perAgent={dashboard.perAgent}
              rollup={dashboard.projectRollup}
              scopeCounts={dashboard.scopeCounts}
              agentCatalog={agentCatalog}
            />
            <div className="grid content-start gap-4">
              <OverviewAgentDistribution perAgent={dashboard.perAgent} />
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
