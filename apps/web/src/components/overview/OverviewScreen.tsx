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
import { ResourceLoadFailure } from "../ResourceLoadFailure";
import { OverviewAgentDistribution } from "./overview-agent-distribution";
import { OverviewCostBreakdown } from "./overview-cost-breakdown";
import { OverviewFilterBar } from "./overview-filter-bar";
import { OverviewKpiGrid } from "./overview-kpi-grid";
import { OverviewSkeleton } from "./overview-skeleton";
import { OverviewUsageChart } from "./overview-usage-chart";

export function OverviewScreen({
  project,
  agent: controlledAgent,
  onAgentChange,
  window,
  agentCatalog,
  rangePreset,
  onRangeChange,
  onSelectCustom,
}: {
  project?: DashboardFilters["project"];
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  window: AppConfig["window"] | null;
  agentCatalog: AgentCatalog;
  rangePreset: TimeWindowPreset;
  onRangeChange: (preset: TimeWindowPreset) => void;
  onSelectCustom: (from: string, to: string) => void;
}) {
  const [ownAgent, setOwnAgent] = useState<string | undefined>(undefined);
  const agent = onAgentChange ? controlledAgent : ownAgent;

  const filters: DashboardFilters = { project, agent };
  const { dashboard, error, retry } = useDashboard(window, filters);

  return (
    <div data-testid="dashboard" className="mx-auto max-w-6xl space-y-4">
      <OverviewFilterBar
        agent={agent}
        onAgentChange={onAgentChange ? undefined : setOwnAgent}
        agentCatalog={agentCatalog}
        scopeCounts={dashboard?.scopeCounts}
        window={window}
        rangePreset={rangePreset}
        onRangeChange={onRangeChange}
        onSelectCustom={onSelectCustom}
      />

      {error ? (
        <ResourceLoadFailure
          title="Couldn't load the dashboard."
          message={error}
          onRetry={() => void retry()}
        />
      ) : null}
      {dashboard ? (
        <>
          <OverviewKpiGrid totals={dashboard.totals} rangeDays={dashboard.window.days} />
          <OverviewUsageChart daily={dashboard.dailyActivity} />
          <div className="grid gap-4 lg:grid-cols-2">
            <OverviewAgentDistribution perAgent={dashboard.perAgent} />
            <OverviewCostBreakdown
              modelCost={dashboard.modelCost}
              modelDistribution={dashboard.modelDistribution}
              totals={dashboard.totals}
            />
          </div>
        </>
      ) : error ? null : (
        <OverviewSkeleton />
      )}
    </div>
  );
}
