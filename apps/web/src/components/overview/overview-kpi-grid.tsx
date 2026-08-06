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
  formatRelativeCn,
  formatUsd,
} from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel } from "../ui/panel";

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

function KpiCard({
  label,
  value,
  trend,
  trendTone = "positive",
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  trend?: string;
  trendTone?: "positive" | "brand";
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
            className={cn(
              "console-mono text-[10.5px]",
              trendTone === "brand" ? "text-[var(--brand)]" : "text-[var(--positive)]",
            )}
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
  if (totals.costEstimated === 0) return "全部来自 agent 记录";
  if (totals.costEstimated === totals.cost && totals.cost > 0) return "全部为单价估算";
  return `含 ${formatUsd(totals.costEstimated)} 估算`;
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

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard
        label="会话"
        value={formatInt(totals.sessions)}
        trend={sessionsTrend ?? undefined}
        hint={rangeDays ? `日均 ${oneDecimal(totals.sessions / rangeDays)}` : undefined}
      />
      <KpiCard
        label="消息"
        value={formatInt(totals.messages)}
        trend={messagesTrend ?? undefined}
        hint={
          totals.sessions > 0
            ? `均 ${oneDecimal(totals.messages / totals.sessions)} / 会话`
            : undefined
        }
      />
      <KpiCard
        label="Tokens"
        value={formatCompact(totals.tokens)}
        trend={tokensTrend ?? undefined}
        hint={`Cache 命中 ${formatPercent(totals.cacheReadTokens / totals.tokens)}`}
      />
      <KpiCard
        label="花费"
        value={formatUsd(totals.cost)}
        trend={costTrend ?? undefined}
        trendTone="brand"
        hint={costHint(totals)}
        emphasis
      />
      <KpiCard
        label="最近活动"
        value={
          totals.latestActivity === undefined ? "暂无活动" : formatRelativeCn(totals.latestActivity)
        }
        trend={totals.latestActivity === undefined ? undefined : "●"}
        hint={totals.latestActivity === undefined ? undefined : latestActivityHint(totals)}
      />
    </div>
  );
}
