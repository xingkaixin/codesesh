import { SourceFilter } from "../nodes/SourceFilter";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
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
 * The time window is NOT owned here — the page bar's range control drives the
 * app's time-window controller, the single source of truth.
 */
import { useState, type ReactNode } from "react";

import type { AgentCatalog } from "../../lib/agents";
import type { AppConfig, DashboardFilters } from "../../lib/api";
import type { TimeWindowPreset } from "../../lib/time-window";
import { useDashboard } from "../../hooks/useDashboard";
import { ResourceLoadFailure } from "../ResourceLoadFailure";
import { OverviewActiveHours } from "./overview-active-hours";
import { OverviewAgentBreakdown, OverviewModelBreakdown } from "./overview-breakdown";
import { OverviewDailyTokens } from "./overview-daily-tokens";
import { OverviewFilterBar } from "./overview-filter-bar";
import { OverviewSkeleton } from "./overview-skeleton";
import { OverviewSummary } from "./overview-summary";

export function OverviewScreen({
  project,
  agent: controlledAgent,
  onAgentChange,
  window,
  agentCatalog,
  rangePreset,
  children,
}: {
  children?: ReactNode;
  project?: DashboardFilters["project"];
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  window: AppConfig["window"] | null;
  agentCatalog: AgentCatalog;
  rangePreset: TimeWindowPreset;
}) {
  useLocale();

  const [sourceNodeId, setSourceNodeId] = useState<string | undefined>(undefined);
  const [ownAgent, setOwnAgent] = useState<string | undefined>(undefined);
  const agent = onAgentChange ? controlledAgent : ownAgent;

  const filters: DashboardFilters = { project, agent, sourceNodeId };
  const { dashboard, error, retry } = useDashboard(window, filters);

  return (
    <div data-testid="dashboard" className="mx-auto max-w-6xl space-y-5">
      <OverviewFilterBar
        agent={agent}
        onAgentChange={onAgentChange ? undefined : setOwnAgent}
        agentCatalog={agentCatalog}
        scopeCounts={dashboard?.scopeCounts}
        window={window}
        rangePreset={rangePreset}
        sourcePicker={
          project ? undefined : <SourceFilter value={sourceNodeId} onChange={setSourceNodeId} />
        }
      />

      {error ? (
        <ResourceLoadFailure
          title={t("Couldn't load the dashboard.")}
          message={error}
          onRetry={() => void retry()}
        />
      ) : null}
      {dashboard ? (
        <>
          <OverviewSummary
            totals={dashboard.totals}
            daily={dashboard.dailyActivity}
            rangeDays={dashboard.window.days}
          />
          {children}
          <OverviewDailyTokens daily={dashboard.dailyActivity} />
          <div className="grid gap-4 lg:grid-cols-2">
            <OverviewModelBreakdown
              models={dashboard.modelDistribution}
              modelCost={dashboard.modelCost}
              totals={dashboard.totals}
            />
            <OverviewAgentBreakdown perAgent={dashboard.perAgent} totals={dashboard.totals} />
          </div>
          <OverviewActiveHours activity={dashboard.activeHours} />
        </>
      ) : error ? null : (
        <OverviewSkeleton />
      )}
      {!dashboard ? children : null}
    </div>
  );
}
