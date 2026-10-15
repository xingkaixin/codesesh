import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * The three numbers the range is read by — tokens spent, their API value and
 * sessions started — each with its own daily trend, then the token composition
 * the first number is made of.
 */
import { useId, type ReactNode } from "react";
import type { DashboardDailyBucket, DashboardTotals } from "../../lib/api";
import { smoothPath, type ChartPoint } from "../../lib/chart-scale";
import {
  formatCompact,
  formatDelta,
  formatInt,
  formatMonthDay,
  formatShare,
  formatUsd,
} from "../../lib/format";
import { TOKEN_KINDS, bucketTokens, sumTokenKinds } from "../../lib/token-usage";
import { cn } from "../../lib/utils";
import { Panel } from "../ui/panel";

const SPARK_WIDTH = 300;
const SPARK_HEIGHT = 40;

function Sparkline({
  values,
  firstLabel,
  lastLabel,
}: {
  values: readonly number[];
  firstLabel: string;
  lastLabel: string;
}) {
  const gradient = useId();
  if (values.length < 2) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((value, index): ChartPoint => [
    (index / (values.length - 1)) * SPARK_WIDTH,
    4 + (1 - (value - min) / span) * (SPARK_HEIGHT - 8),
  ]);
  const line = smoothPath(points);
  const last = points.at(-1)!;

  return (
    <div aria-hidden className="mt-3">
      <div className="relative">
        <svg
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-10 w-full overflow-visible"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--brand)" stopOpacity="0.18" />
              <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${line} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT} Z`}
            fill={`url(#${gradient})`}
          />
          <path
            d={line}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="1.75"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          className="absolute right-0 size-[7px] translate-x-1/2 translate-y-1/2 rounded-full bg-[var(--brand)] shadow-[0_0_0_2px_var(--console-surface)]"
          style={{ bottom: SPARK_HEIGHT - last[1] }}
        />
      </div>
      <div className="console-mono mt-1 flex justify-between text-[10px] text-[var(--console-muted)]">
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  );
}

function Metric({
  label,
  badge,
  value,
  delta,
  deltaTone = "neutral",
  detail,
  divided,
  children,
}: {
  label: string;
  badge?: ReactNode;
  value: string;
  delta: string | null;
  deltaTone?: "neutral" | "warning" | "positive";
  detail?: string;
  divided: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-1 px-6 pt-5 pb-4",
        divided ? "border-t border-[var(--console-border)] md:border-t-0 md:border-l" : null,
      )}
    >
      <div className="flex items-center gap-2 text-xs text-[var(--console-muted)]">
        <h3 className="font-normal">{label}</h3>
        {badge}
        {delta === null ? null : (
          <span
            data-testid="overview-kpi-trend"
            className={cn(
              "console-mono ml-auto rounded-full bg-[var(--console-surface-muted)] px-[7px] text-[11px] shadow-[inset_0_0_0_1px_var(--console-border)]",
              deltaTone === "warning"
                ? "text-[var(--console-warning)]"
                : deltaTone === "positive"
                  ? "text-[var(--positive)]"
                  : "text-[var(--console-text-secondary)]",
            )}
          >
            {delta}
          </span>
        )}
      </div>
      <p className="console-mono text-[34px] leading-[1.15] font-light tracking-[-0.02em] whitespace-nowrap text-[var(--console-text)]">
        {value}
      </p>
      {detail ? <p className="text-[11px] text-[var(--console-muted)]">{detail}</p> : null}
      {children}
    </section>
  );
}

export function OverviewSummary({
  totals,
  daily,
  rangeDays,
}: {
  totals: DashboardTotals;
  daily: readonly DashboardDailyBucket[];
  rangeDays?: number;
}) {
  useLocale();

  const previous = totals.previous;
  const delta = (current: number, base: number | undefined) =>
    base === undefined ? null : formatDelta(current, base);
  const costTone =
    previous?.cost === undefined ? "neutral" : totals.cost > previous.cost ? "warning" : "positive";
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");

  const first = daily[0];
  const last = daily.at(-1);
  const firstLabel = first ? formatMonthDay(first.date) : "";
  const lastLabel = (value: string) => (last ? `${formatMonthDay(last.date)} ${value}` : value);

  const kinds = sumTokenKinds(daily);
  const kindTotal = TOKEN_KINDS.reduce((sum, kind) => sum + kinds[kind.key], 0);
  const compositionLabel = TOKEN_KINDS.map(
    (kind) => `${t(kind.label)} ${formatShare(kinds[kind.key] / kindTotal)}`,
  ).join(", ");

  return (
    <Panel aria-label={t("Usage summary")} className="overflow-hidden">
      <div className="grid md:grid-cols-3">
        <Metric
          label={t("Tokens")}
          value={formatCompact(totals.tokens)}
          delta={delta(totals.tokens, previous?.tokens)}
          detail={join(
            rangeDays ? t("{0}/day", [formatCompact(totals.tokens / rangeDays)]) : null,
            totals.tokens > 0
              ? t("Cache hit {0}", [formatShare(totals.cacheReadTokens / totals.tokens)])
              : null,
          )}
          divided={false}
        >
          <Sparkline
            values={daily.map((bucket) => bucketTokens(bucket))}
            firstLabel={firstLabel}
            lastLabel={lastLabel(last ? formatCompact(bucketTokens(last)) : "")}
          />
        </Metric>
        <Metric
          label={t("API value")}
          badge={
            totals.costEstimated > 0 ? (
              <span className="rounded-full bg-[var(--console-warning-bg)] px-2 text-[11px] font-medium text-[var(--console-warning)]">
                {t("Estimated")}
              </span>
            ) : null
          }
          value={formatUsd(totals.cost)}
          delta={delta(totals.cost, previous?.cost)}
          deltaTone={costTone}
          detail={rangeDays ? t("{0}/day", [formatUsd(totals.cost / rangeDays)]) : undefined}
          divided
        >
          <Sparkline
            values={daily.map((bucket) => bucket.cost)}
            firstLabel={firstLabel}
            lastLabel={lastLabel(last ? formatUsd(last.cost) : "")}
          />
        </Metric>
        <Metric
          label={t("Sessions")}
          value={formatInt(totals.sessions)}
          delta={delta(totals.sessions, previous?.sessions)}
          detail={join(
            t("{0} messages", [formatInt(totals.messages)]),
            totals.sessions > 0
              ? t("{0}/session", [(totals.messages / totals.sessions).toFixed(1)])
              : null,
          )}
          divided
        >
          <Sparkline
            values={daily.map((bucket) => bucket.sessions)}
            firstLabel={firstLabel}
            lastLabel={lastLabel(last ? formatInt(last.sessions) : "")}
          />
        </Metric>
      </div>

      <div className="border-t border-[var(--console-border)] bg-[var(--console-bg)] px-6 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--console-text)]">
            {t("Token composition")}
          </h3>
          <span className="console-mono text-[11px] text-[var(--console-muted)]">
            {formatCompact(kindTotal)}
          </span>
        </div>
        {kindTotal > 0 ? (
          <div role="img" aria-label={compositionLabel} className="mt-3 flex h-3.5 gap-0.5">
            {TOKEN_KINDS.map((kind) =>
              kinds[kind.key] > 0 ? (
                <span
                  key={kind.key}
                  className={cn("min-w-[3px] rounded-[3px]", kind.swatch)}
                  style={{ flex: `${kinds[kind.key]} 1 0` }}
                />
              ) : null,
            )}
          </div>
        ) : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
          {TOKEN_KINDS.map((kind) => (
            <div key={kind.key} className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-[var(--console-text-secondary)]">
                <span aria-hidden className={cn("size-2.5 rounded-[3px]", kind.swatch)} />
                {t(kind.label)}
              </dt>
              <dd className="console-mono mt-0.5 text-[13px] text-[var(--console-text)]">
                {formatCompact(kinds[kind.key])}{" "}
                <span className="text-[11px] text-[var(--console-muted)]">
                  {formatShare(kinds[kind.key] / kindTotal)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        {totals.costEstimated > 0 ? (
          <p className="mt-3 text-[11px] text-[var(--console-muted)]">
            {t(
              "API value prices this usage at public model rates where an agent records no cost. It is not a bill.",
            )}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
