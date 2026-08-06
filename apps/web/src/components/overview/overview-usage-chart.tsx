/**
 * Per-day usage: a stacked bar per calendar day with the day's cost drawn over
 * it as a line. Plain DOM plus one inline <svg> — a stacked bar and a polyline
 * do not justify a charting library, and the hidden table keeps the data
 * readable without colour.
 */
import type { DashboardDailyBucket } from "../../lib/api";
import { formatCompact, formatInt, formatMonthDay, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel, PanelHeader } from "../ui/panel";
import { SegmentedControl } from "../ui/segmented-control";
import { OVERVIEW_METRIC_LABEL, type OverviewMetric } from "./types";

const CHART_HEIGHT = 168;

const METRIC_OPTIONS = [
  { value: "tokens", label: OVERVIEW_METRIC_LABEL.tokens },
  { value: "sessions", label: OVERVIEW_METRIC_LABEL.sessions },
  { value: "messages", label: OVERVIEW_METRIC_LABEL.messages },
] as const;

const TOKEN_SERIES = [
  { key: "cache_create", label: "Cache write", color: "var(--chart-4)" },
  { key: "cache_read", label: "Cache read", color: "var(--chart-3)" },
  { key: "output", label: "Output", color: "var(--chart-2)" },
  { key: "input", label: "Input", color: "var(--chart-1)" },
] as const;

function bucketTokens(bucket: DashboardDailyBucket): number {
  return bucket.input + bucket.output + bucket.cache_read + bucket.cache_create;
}

function bucketValue(bucket: DashboardDailyBucket, metric: OverviewMetric): number {
  if (metric === "sessions") return bucket.sessions;
  if (metric === "messages") return bucket.messages;
  return bucketTokens(bucket);
}

/** Top-to-bottom pixel heights; the bottom segment absorbs the rounding error
 *  so a stacked bar never shows a 1px seam against its own total height. */
function segmentHeights(bucket: DashboardDailyBucket, barHeight: number): number[] {
  const total = bucketTokens(bucket);
  if (total <= 0 || barHeight <= 0) return TOKEN_SERIES.map(() => 0);

  let used = 0;
  return TOKEN_SERIES.map((series, index) => {
    if (index === TOKEN_SERIES.length - 1) return barHeight - used;
    const height = Math.round((barHeight * bucket[series.key]) / total);
    used += height;
    return height;
  });
}

function costPolylinePoints(daily: DashboardDailyBucket[], maxCost: number): string {
  return daily
    .map((bucket, index) => {
      const x = ((index + 0.5) / daily.length) * 100;
      const y = 100 - (bucket.cost / maxCost) * 100 * 0.82;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function OverviewUsageChart({
  daily,
  metric,
  onMetricChange,
  hoverDayIndex,
  onHoverDayChange,
}: {
  daily: DashboardDailyBucket[];
  metric: OverviewMetric;
  onMetricChange: (metric: OverviewMetric) => void;
  hoverDayIndex: number | null;
  onHoverDayChange: (index: number | null) => void;
}) {
  const first = daily[0];
  const last = daily[daily.length - 1];
  const maxValue = daily.reduce((peak, bucket) => Math.max(peak, bucketValue(bucket, metric)), 0);
  const maxCost = daily.reduce((peak, bucket) => Math.max(peak, bucket.cost), 0);
  const hovered = hoverDayIndex == null ? undefined : daily[hoverDayIndex];
  const range =
    first && last ? ` · ${formatMonthDay(first.date)} → ${formatMonthDay(last.date)}` : "";

  return (
    <Panel role="region" aria-label="Daily usage" className="p-4">
      <PanelHeader
        title="Daily usage"
        action={
          <SegmentedControl
            options={METRIC_OPTIONS}
            value={metric}
            onChange={onMetricChange}
            size="sm"
            ariaLabel="Usage metric"
          />
        }
      />
      <p className="console-mono mt-1 text-[10.5px] text-[var(--console-muted)]">
        Bars = {OVERVIEW_METRIC_LABEL[metric]} · Line = daily cost{range}
      </p>

      <div className="console-mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--console-muted)]">
        {metric === "tokens"
          ? TOKEN_SERIES.map((series) => (
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
            ))
          : null}
        {maxCost > 0 ? (
          <span className="flex items-center gap-1">
            <span className="h-px w-3 bg-[var(--brand)]" aria-hidden />
            Cost
          </span>
        ) : null}
      </div>

      {daily.length === 0 ? (
        <p className="console-mono mt-[14px] text-[11px] text-[var(--console-muted)]">
          No usage data
        </p>
      ) : (
        <>
          <div className="relative mt-[14px]" style={{ height: CHART_HEIGHT }}>
            <div className="absolute inset-0 flex flex-col justify-between" aria-hidden>
              {[0, 1, 2, 3].map((line) => (
                <span key={line} className="h-px bg-[var(--console-border)]" />
              ))}
            </div>

            <div className="absolute inset-0 flex items-end gap-[3px]">
              {daily.map((bucket, index) => {
                const value = bucketValue(bucket, metric);
                const barHeight = maxValue > 0 ? Math.round((value / maxValue) * CHART_HEIGHT) : 0;
                const heights = segmentHeights(bucket, barHeight);
                return (
                  <button
                    key={bucket.date}
                    type="button"
                    aria-label={`${formatMonthDay(bucket.date)} usage`}
                    onMouseEnter={() => onHoverDayChange(index)}
                    onMouseLeave={() => onHoverDayChange(null)}
                    onFocus={() => onHoverDayChange(index)}
                    onBlur={() => onHoverDayChange(null)}
                    className="flex h-full flex-1 flex-col justify-end focus-visible:outline-none"
                  >
                    <span
                      className={cn(
                        "flex flex-col overflow-hidden rounded-t-[3px]",
                        hoverDayIndex === index
                          ? "outline outline-1 outline-[var(--brand-line)]"
                          : null,
                      )}
                      style={{ height: barHeight }}
                    >
                      {metric === "tokens" ? (
                        TOKEN_SERIES.map((series, seriesIndex) => (
                          <span
                            key={series.key}
                            style={{ height: heights[seriesIndex], background: series.color }}
                          />
                        ))
                      ) : (
                        <span className="h-full" style={{ background: "var(--chart-1)" }} />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {maxCost > 0 ? (
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              >
                <polyline
                  points={costPolylinePoints(daily, maxCost)}
                  fill="none"
                  stroke="var(--brand)"
                  strokeWidth="0.9"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}

            {hovered && hoverDayIndex != null ? (
              <div
                className={cn(
                  "console-mono pointer-events-none absolute top-2 z-10 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-[10.5px] whitespace-nowrap text-[var(--console-text)] shadow-[var(--shadow-overlay)]",
                  hoverDayIndex >= daily.length * 0.75 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: `${((hoverDayIndex + 0.5) / daily.length) * 100}%` }}
              >
                <div>{formatMonthDay(hovered.date)}</div>
                <div>
                  {formatCompact(bucketTokens(hovered))} tok ·{" "}
                  <span className="text-[var(--brand)]">{formatUsd(hovered.cost)}</span>
                </div>
                <div>
                  {formatInt(hovered.sessions)} sessions · {formatInt(hovered.messages)} messages
                </div>
                <div className="text-[var(--console-muted)]">
                  In {formatCompact(hovered.input)} · Out {formatCompact(hovered.output)} · Read{" "}
                  {formatCompact(hovered.cache_read)} · Write {formatCompact(hovered.cache_create)}
                </div>
              </div>
            ) : null}
          </div>

          <div className="console-mono mt-2 flex text-[10px] text-[var(--console-muted)]">
            {daily.map((bucket, index) => (
              <span key={bucket.date} className="flex-1 text-center">
                {index === 0 || index === daily.length - 1 || index % 6 === 0
                  ? formatMonthDay(bucket.date)
                  : ""}
              </span>
            ))}
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
