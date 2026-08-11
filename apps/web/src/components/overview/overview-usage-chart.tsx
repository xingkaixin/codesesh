/**
 * Per-day usage. Two plots share one time axis: a stacked bar per calendar day
 * for the token composition, and the day's cost as an area below it. Cost and
 * tokens are different quantities, so they get different plots rather than two
 * scales on one — the columns line up vertically and are read together.
 */
import { useMemo, useState } from "react";

import type { BarHover } from "../../hooks/useBarField";
import type { DashboardDailyBucket } from "../../lib/api";
import { niceMax } from "../../lib/chart-shading";
import { formatCompact, formatInt, formatMonthDay, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel, PanelHeader } from "../ui/panel";
import { TileAreaPlot } from "../ui/tile-area-plot";
import { TILE_AXIS_WIDTH, TileBarPlot } from "../ui/tile-bar-plot";

const BAR_HEIGHT = 168;
const COST_HEIGHT = 132;
/** Any denser and the dates collide at a 30-day range. */
const MAX_DATE_TICKS = 6;

/** The gap is what makes a lopsided stack readable: cache reads dwarf the other
 *  classes, so without it the bar reads as one band. */
const BAR_LAYOUT = { barRatio: 0.86, barMax: 46, bandGap: 2, minBand: 3 };

/** Bottom to top, deepest step at the base of every bar. */
const TOKEN_SERIES = [
  { key: "input", label: "Input", color: "var(--token-input)" },
  { key: "output", label: "Output", color: "var(--token-output)" },
  { key: "cache_read", label: "Cache read", color: "var(--token-cache-read)" },
  { key: "cache_create", label: "Cache write", color: "var(--token-cache-write)" },
] as const;

const TOKEN_COLORS = TOKEN_SERIES.map((series) => series.color);

/** Axis ticks land on arbitrary fractions of the peak, so cents would be noise
 *  in a 38px gutter. */
function formatCostTick(value: number): string {
  return value >= 1000 ? `$${formatCompact(value)}` : `$${Math.round(value)}`;
}

function bucketTokens(bucket: DashboardDailyBucket): number {
  return bucket.input + bucket.output + bucket.cache_read + bucket.cache_create;
}

function bucketSummary(bucket: DashboardDailyBucket): string {
  return `${formatMonthDay(bucket.date)}: ${formatCompact(bucketTokens(bucket))} tokens, ${formatUsd(bucket.cost)}, ${formatInt(bucket.sessions)} sessions, ${formatInt(bucket.messages)} messages, input ${formatCompact(bucket.input)}, output ${formatCompact(bucket.output)}, cache read ${formatCompact(bucket.cache_read)}, cache write ${formatCompact(bucket.cache_create)}`;
}

function CostArea({ daily }: { daily: DashboardDailyBucket[] }) {
  const costs = useMemo(() => daily.map((bucket) => bucket.cost), [daily]);
  const labels = useMemo(() => daily.map((bucket) => formatMonthDay(bucket.date)), [daily]);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const peak = costs.reduce((max, cost) => Math.max(max, cost), 0);
  if (peak <= 0) return null;

  return (
    <>
      <div className="mt-[14px] flex items-baseline justify-between border-t border-dashed border-[var(--console-border)] pt-[11px]">
        <span className="console-mono text-[10.5px] text-[var(--console-text)]">Daily cost</span>
        <span className="console-mono text-[10px] text-[var(--console-muted)]">
          Peak {formatUsd(peak)} · Avg {formatUsd(total / daily.length)} · Total {formatUsd(total)}
        </span>
      </div>
      <TileAreaPlot
        values={costs}
        max={peak}
        labels={labels}
        height={COST_HEIGHT}
        formatValue={formatUsd}
        formatTick={formatCostTick}
        className="mt-[7px]"
      />
    </>
  );
}

function DayTooltip({
  bucket,
  index,
  count,
}: {
  bucket: DashboardDailyBucket;
  index: number;
  count: number;
}) {
  return (
    <div
      className={cn(
        "console-mono pointer-events-none absolute top-2 z-10 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-[10.5px] whitespace-nowrap text-[var(--console-text)] shadow-[var(--shadow-overlay)]",
        index >= count * 0.75 ? "-translate-x-full" : "-translate-x-1/2",
      )}
      style={{ left: `${((index + 0.5) / count) * 100}%` }}
    >
      <div>{formatMonthDay(bucket.date)}</div>
      <div>
        {formatCompact(bucketTokens(bucket))} tok ·{" "}
        <span className="text-[var(--brand)]">{formatUsd(bucket.cost)}</span>
      </div>
      <div>
        {formatInt(bucket.sessions)} sessions · {formatInt(bucket.messages)} messages
      </div>
      <div className="text-[var(--console-muted)]">
        In {formatCompact(bucket.input)} · Out {formatCompact(bucket.output)} · Read{" "}
        {formatCompact(bucket.cache_read)} · Write {formatCompact(bucket.cache_create)}
      </div>
    </div>
  );
}

function TokenBars({ daily }: { daily: DashboardDailyBucket[] }) {
  const [hover, setHover] = useState<BarHover | null>(null);
  const values = useMemo(
    () => daily.map((bucket) => TOKEN_SERIES.map((series) => bucket[series.key])),
    [daily],
  );
  const itemLabels = useMemo(() => daily.map(bucketSummary), [daily]);
  const axisMax = useMemo(
    () => niceMax(daily.reduce((peak, bucket) => Math.max(peak, bucketTokens(bucket)), 0)),
    [daily],
  );
  const hovered = hover === null ? undefined : daily[hover.column];

  return (
    <div className="relative mt-[14px]">
      <TileBarPlot
        values={values}
        axisMax={axisMax}
        colors={TOKEN_COLORS}
        hovered={hover}
        onHover={setHover}
        layout={BAR_LAYOUT}
        height={BAR_HEIGHT}
        formatTick={formatCompact}
        ariaLabel="Daily usage chart"
        itemLabels={itemLabels}
      />
      {hovered && hover ? (
        <div className="absolute inset-x-0 top-0" style={{ left: TILE_AXIS_WIDTH }}>
          <DayTooltip bucket={hovered} index={hover.column} count={daily.length} />
        </div>
      ) : null}
    </div>
  );
}

export function OverviewUsageChart({ daily }: { daily: DashboardDailyBucket[] }) {
  const first = daily[0];
  const last = daily[daily.length - 1];
  const range =
    first && last ? ` · ${formatMonthDay(first.date)} → ${formatMonthDay(last.date)}` : "";
  const tickStep = Math.max(1, Math.ceil(daily.length / MAX_DATE_TICKS));

  return (
    <Panel role="region" aria-label="Daily usage" className="p-4">
      <PanelHeader
        title="Daily usage"
        action={
          <div className="console-mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--console-muted)]">
            {TOKEN_SERIES.map((series) => (
              <span
                key={series.key}
                data-testid="overview-legend-token"
                className="flex items-center gap-1"
              >
                <span
                  className="size-2 rounded-[2px]"
                  style={{ background: series.color }}
                  aria-hidden
                />
                {series.label}
              </span>
            ))}
          </div>
        }
      />
      <p className="console-mono mt-1 text-[10.5px] text-[var(--console-muted)]">
        Stacked bars = token mix · Area below = daily cost{range}
      </p>

      {daily.length === 0 ? (
        <p className="console-mono mt-[14px] text-[11px] text-[var(--console-muted)]">
          No usage data
        </p>
      ) : (
        <>
          <TokenBars daily={daily} />

          <CostArea daily={daily} />

          <div style={{ paddingLeft: TILE_AXIS_WIDTH }}>
            <div className="console-mono mt-2 flex text-[10px] text-[var(--console-muted)]">
              {daily.map((bucket, index) => (
                <span key={bucket.date} className="flex-1 text-center">
                  {index % tickStep === 0 || index === daily.length - 1
                    ? formatMonthDay(bucket.date)
                    : ""}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      <table className="sr-only" aria-label="Daily usage data">
        <thead>
          <tr>
            <th>Date</th>
            <th>Sessions</th>
            <th>Messages</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((bucket) => (
            <tr key={bucket.date}>
              <td>{formatMonthDay(bucket.date)}</td>
              <td>{formatInt(bucket.sessions)}</td>
              <td>{formatInt(bucket.messages)}</td>
              <td>{formatInt(bucketTokens(bucket))}</td>
              <td>{formatUsd(bucket.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
