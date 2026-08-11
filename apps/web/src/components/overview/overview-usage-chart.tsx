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
import { TILE_AXIS_WIDTH, TileBarPlot } from "../ui/tile-bar-plot";

const BAR_HEIGHT = 168;
const COST_HEIGHT = 52;
/** Leaves the peak clear of the panel above it. */
const COST_HEADROOM = 0.9;
/** Any denser and the dates collide at a 30-day range. */
const MAX_DATE_TICKS = 6;

const BAR_LAYOUT = { barRatio: 0.86, barMax: 46, bandGap: 0, minBand: 1 };

/** Bottom to top, deepest blue at the base of every bar. */
const TOKEN_SERIES = [
  { key: "input", label: "Input", color: "var(--token-input)" },
  { key: "output", label: "Output", color: "var(--token-output)" },
  { key: "cache_read", label: "Cache read", color: "var(--token-cache-read)" },
  { key: "cache_create", label: "Cache write", color: "var(--token-cache-write)" },
] as const;

const TOKEN_COLORS = TOKEN_SERIES.map((series) => series.color);

function bucketTokens(bucket: DashboardDailyBucket): number {
  return bucket.input + bucket.output + bucket.cache_read + bucket.cache_create;
}

function costAreaPoints(daily: DashboardDailyBucket[], maxCost: number) {
  const edge = daily.map((bucket, index) => {
    const x = ((index + 0.5) / daily.length) * 100;
    const y = 100 - (bucket.cost / maxCost) * 100 * COST_HEADROOM;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const first = `0,${100}`;
  const last = `100,${100}`;
  return { edge: edge.join(" "), area: [first, ...edge, last].join(" ") };
}

function CostArea({ daily }: { daily: DashboardDailyBucket[] }) {
  const costs = daily.map((bucket) => bucket.cost);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const peak = costs.reduce((max, cost) => Math.max(max, cost), 0);
  if (peak <= 0) return null;

  const { edge, area } = costAreaPoints(daily, peak);

  return (
    <>
      <div className="mt-[14px] flex items-baseline justify-between border-t border-dashed border-[var(--console-border)] pt-[11px]">
        <span className="console-mono text-[10.5px] text-[var(--console-text)]">Daily cost</span>
        <span className="console-mono text-[10px] text-[var(--console-muted)]">
          Peak {formatUsd(peak)} · Avg {formatUsd(total / daily.length)} · Total {formatUsd(total)}
        </span>
      </div>
      <div className="relative mt-[7px]" style={{ height: COST_HEIGHT }} aria-hidden>
        <span className="absolute inset-x-0 bottom-0 h-px bg-[var(--console-border)]" />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
        >
          <polygon points={area} fill="var(--brand)" fillOpacity="0.18" />
          <polyline
            points={edge}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
      </div>
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

export function OverviewUsageChart({ daily }: { daily: DashboardDailyBucket[] }) {
  const [hover, setHover] = useState<BarHover | null>(null);

  const values = useMemo(
    () => daily.map((bucket) => TOKEN_SERIES.map((series) => bucket[series.key])),
    [daily],
  );
  const axisMax = niceMax(daily.reduce((peak, bucket) => Math.max(peak, bucketTokens(bucket)), 0));

  const first = daily[0];
  const last = daily[daily.length - 1];
  const range =
    first && last ? ` · ${formatMonthDay(first.date)} → ${formatMonthDay(last.date)}` : "";
  const hovered = hover === null ? undefined : daily[hover.column];
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
            />
            {hovered && hover ? (
              <div className="absolute inset-x-0 top-0" style={{ left: TILE_AXIS_WIDTH }}>
                <DayTooltip bucket={hovered} index={hover.column} count={daily.length} />
              </div>
            ) : null}
          </div>

          <div style={{ paddingLeft: TILE_AXIS_WIDTH }}>
            <CostArea daily={daily} />
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
