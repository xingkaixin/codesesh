import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * Agent share of the current scope, as one bar per agent. Cost is the ranking
 * metric only when some agent actually has one — printing $0.00 five times says
 * nothing, so a cost-free scope ranks and reads by session count instead.
 */
import { useMemo, useState } from "react";

import type { BarHover } from "../../hooks/useBarField";
import type { DashboardAgentStat } from "../../lib/api";
import { formatInt, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIcon";
import { Panel, PanelHeader } from "../ui/panel";
import { TileBarPlot } from "../ui/tile-bar-plot";

const AGENT_LIMIT = 6;
const CHART_HEIGHT = 118;
const BAR_LAYOUT = { barRatio: 0.52, barMax: 34, bandGap: 0, minBand: 4 };
const BAR_COLORS = ["var(--brand)"];

export function OverviewAgentDistribution({ perAgent }: { perAgent: DashboardAgentStat[] }) {
  const locale = useLocale();

  const [hover, setHover] = useState<BarHover | null>(null);

  const { byCost, visible, values, axisMax, itemLabels } = useMemo(
    () => {
      const byCost = perAgent.some((agent) => agent.cost > 0);
      const weightOf = (agent: DashboardAgentStat) => (byCost ? agent.cost : agent.sessions);
      const visible = [...perAgent].sort((a, b) => weightOf(b) - weightOf(a)).slice(0, AGENT_LIMIT);
      const values = visible.map((agent) => [weightOf(agent)]);
      const itemLabels = visible.map((agent) =>
        byCost
          ? t("{0}: {1}, {2} sessions", [
              agent.displayName,
              formatUsd(agent.cost),
              formatInt(agent.sessions),
            ])
          : t("{0}: {1} sessions", [agent.displayName, formatInt(agent.sessions)]),
      );
      // The leader touches the top: with the figures printed under every bar
      // there is no axis to round to, and rounded headroom would just be blank.
      return { byCost, visible, values, axisMax: Math.max(...values.flat(), 0), itemLabels };
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, perAgent],
  );

  return (
    <Panel role="region" aria-label={t("Agents")} className="p-4">
      <PanelHeader
        title={t("Agents")}
        meta={t("{0} · {1} total", [byCost ? t("by cost") : t("by sessions"), perAgent.length])}
      />

      {visible.length === 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">{t("No data")}</p>
      ) : (
        <div className="mt-[14px]">
          <TileBarPlot
            values={values}
            axisMax={axisMax}
            colors={BAR_COLORS}
            hovered={hover}
            onHover={setHover}
            layout={BAR_LAYOUT}
            height={CHART_HEIGHT}
            ariaLabel={t("Agent distribution chart")}
            itemLabels={itemLabels}
          />
          <div
            className="mt-2 grid"
            style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))` }}
          >
            {visible.map((agent, index) => (
              <div
                key={agent.name}
                data-testid="overview-agent-row"
                className="flex min-w-0 flex-col items-center gap-[5px]"
              >
                <span className="flex size-[18px] items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                  <AgentIcon
                    icon={agent.icon}
                    iconColored={agent.iconColored}
                    alt={agent.displayName}
                    className="size-[10px]"
                  />
                </span>
                <span
                  className={cn(
                    "console-mono max-w-full truncate text-[9.5px]",
                    hover?.column === index
                      ? "text-[var(--console-text)]"
                      : "text-[var(--console-muted)]",
                  )}
                >
                  {agent.displayName}
                </span>
                <span className="console-mono text-[9.5px] text-[var(--console-text)]">
                  {byCost ? formatUsd(agent.cost) : formatInt(agent.sessions)}
                </span>
                {byCost ? (
                  <span className="console-mono text-[9.5px] text-[var(--console-muted)]">
                    {formatInt(agent.sessions)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {perAgent.length > AGENT_LIMIT ? (
        <p className="console-mono mt-3 text-[10.5px] text-[var(--console-muted)]">
          + {perAgent.length - AGENT_LIMIT} {t("more")}
        </p>
      ) : null}
    </Panel>
  );
}
