/**
 * The five headline numbers. Every secondary line is optional by design: a trend
 * without a comparable baseline, or a rate without a denominator, is omitted
 * rather than faked.
 */
import type { DashboardTotals } from "../../lib/api";
import {
  formatCompact,
  formatDelta,
  formatInt,
  formatPercent,
  formatRelativeShort,
  formatUsd,
} from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel } from "../ui/panel";

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

/** Activity counts rising or falling is a neutral fact; only cost carries a judgement. */
type TrendTone = "neutral" | "warning" | "positive";

const TREND_TONE_CLASS: Record<TrendTone, string> = {
  neutral: "text-[var(--console-muted)]",
  warning: "text-[var(--brand)]",
  positive: "text-[var(--positive)]",
};

function KpiCard({
  label,
  value,
  trend,
  trendTone = "neutral",
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  trend?: string;
  trendTone?: TrendTone;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <Panel className={cn("px-4 py-[14px]", emphasis ? "border-[var(--brand-line)]" : null)}>
      <p className="console-eyebrow">{label}</p>
      <p
        className={cn(
          "console-mono mt-[9px] text-[27px] font-semibold tracking-[-0.02em]",
          emphasis ? "text-[var(--brand)]" : "text-[var(--console-text)]",
        )}
      >
        {value}
      </p>
      <div className="mt-[7px] flex items-center gap-[7px]">
        {trend === undefined ? null : (
          <span
            data-testid="overview-kpi-trend"
            className={cn("console-mono text-[10.5px]", TREND_TONE_CLASS[trendTone])}
          >
            {trend}
          </span>
        )}
        {hint === undefined ? null : (
          <span className="console-mono truncate text-[10.5px] text-[var(--console-muted)]">
            {hint}
          </span>
        )}
      </div>
    </Panel>
  );
}

function costHint(totals: DashboardTotals): string {
  if (totals.costEstimated === 0) return "All recorded by agents";
  if (totals.costEstimated === totals.cost && totals.cost > 0)
    return "All estimated from unit price";
  return `${formatUsd(totals.costEstimated)} estimated`;
}

function latestActivityHint(totals: DashboardTotals): string | undefined {
  const parts = [totals.latestActivityProject, totals.latestActivityAgent].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function OverviewKpiGrid({
  totals,
  rangeDays,
}: {
  totals: DashboardTotals;
  rangeDays?: number;
}) {
  const previous = totals.previous;
  const delta = (current: number, base: number | undefined) =>
    base === undefined ? null : formatDelta(current, base);

  const sessionsTrend = delta(totals.sessions, previous?.sessions);
  const messagesTrend = delta(totals.messages, previous?.messages);
  const tokensTrend = delta(totals.tokens, previous?.tokens);
  const costTrend = delta(totals.cost, previous?.cost);
  const costRising = previous?.cost !== undefined && totals.cost > previous.cost;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard
        label="Sessions"
        value={formatInt(totals.sessions)}
        trend={sessionsTrend ?? undefined}
        hint={rangeDays ? `${oneDecimal(totals.sessions / rangeDays)}/day` : undefined}
      />
      <KpiCard
        label="Messages"
        value={formatInt(totals.messages)}
        trend={messagesTrend ?? undefined}
        hint={
          totals.sessions > 0
            ? `${oneDecimal(totals.messages / totals.sessions)}/session`
            : undefined
        }
      />
      <KpiCard
        label="Tokens"
        value={formatCompact(totals.tokens)}
        trend={tokensTrend ?? undefined}
        hint={`Cache hit ${formatPercent(totals.cacheReadTokens / totals.tokens)}`}
      />
      <KpiCard
        label="Cost"
        value={formatUsd(totals.cost)}
        trend={costTrend ?? undefined}
        trendTone={costRising ? "warning" : "positive"}
        hint={costHint(totals)}
        emphasis
      />
      <KpiCard
        label="Last activity"
        value={
          totals.latestActivity === undefined
            ? "No activity"
            : formatRelativeShort(totals.latestActivity)
        }
        trend={totals.latestActivity === undefined ? undefined : "●"}
        trendTone="positive"
        hint={totals.latestActivity === undefined ? undefined : latestActivityHint(totals)}
      />
    </div>
  );
}
