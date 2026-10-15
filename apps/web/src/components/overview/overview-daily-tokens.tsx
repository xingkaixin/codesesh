import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * Tokens per calendar day, stacked by kind, with the day's API value drawn as a
 * line on its own right-hand axis. Cache reads usually dwarf the other kinds, so
 * they can be left out to read the fresh tokens at a useful scale.
 */
import { useMemo, useState } from "react";
import type { DashboardDailyBucket } from "../../lib/api";
import { niceMax, smoothPath, type ChartPoint } from "../../lib/chart-scale";
import { formatCompact, formatInt, formatMonthDay, formatUsd } from "../../lib/format";
import { TOKEN_KINDS, bucketTokens } from "../../lib/token-usage";
import { cn } from "../../lib/utils";
import { ChartKeyboardList } from "../ui/chart-keyboard-list";
import { ChartTooltip } from "../ui/chart-tooltip";
import { Panel } from "../ui/panel";
import { SegmentedControl } from "../ui/segmented-control";

const PLOT_HEIGHT = 240;
const TICKS = [1, 0.75, 0.5, 0.25, 0];
/** Above this many days the per-bar labels and weekday names collide. */
const LABELLED_DAYS = 14;
const MAX_DATE_TICKS = 7;

type Scope = "all" | "fresh";

function formatCostTick(value: number): string {
  if (value === 0) return "$0";
  if (value >= 1000) return `$${formatCompact(value)}`;
  if (value >= 1) return `$${Number(value.toFixed(2))}`;
  return `$${Number(value.toPrecision(2))}`;
}

function calendarDay(date: string): Date {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** Day index → tick order. Narrow screens show every other tick. */
function dateTicks(count: number): Map<number, number> {
  const indexes =
    count <= LABELLED_DAYS
      ? Array.from({ length: count }, (_, index) => index)
      : Array.from({ length: MAX_DATE_TICKS }, (_, index) =>
          Math.round((index * (count - 1)) / (MAX_DATE_TICKS - 1)),
        );
  return new Map(indexes.map((index, order) => [index, order]));
}

export function OverviewDailyTokens({ daily }: { daily: readonly DashboardDailyBucket[] }) {
  const locale = useLocale();
  const [scope, setScope] = useState<Scope>("all");
  const [active, setActive] = useState<number | null>(null);
  const withCacheRead = scope === "all";
  const kinds = withCacheRead
    ? TOKEN_KINDS
    : TOKEN_KINDS.filter((kind) => kind.key !== "cache_read");

  const chart = useMemo(() => {
    const totals = daily.map((bucket) => bucketTokens(bucket, withCacheRead));
    const tokenMax = niceMax(Math.max(0, ...totals));
    const costMax = niceMax(Math.max(0, ...daily.map((bucket) => bucket.cost)));
    const average = totals.length
      ? totals.reduce((sum, value) => sum + value, 0) / totals.length
      : 0;
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    const days = daily.map((bucket) => {
      const date = calendarDay(bucket.date);
      return {
        label: formatMonthDay(bucket.date),
        weekday: weekday.format(date),
        weekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
      };
    });
    const costPoints = daily.map((bucket, index): ChartPoint => [
      index * 100 + 50,
      PLOT_HEIGHT - (bucket.cost / costMax) * PLOT_HEIGHT,
    ]);
    const itemLabels = daily.map((bucket, index) =>
      t("{0}: {1} tokens, API value {2}, {3} sessions", [
        days[index]!.label,
        formatCompact(totals[index]!),
        formatUsd(bucket.cost),
        formatInt(bucket.sessions),
      ]),
    );
    return { totals, tokenMax, costMax, average, days, costPoints, itemLabels };
  }, [daily, withCacheRead, locale]);

  const count = daily.length;
  const labelled = count <= LABELLED_DAYS;
  const hasCost = daily.some((bucket) => bucket.cost > 0);
  const ticks = dateTicks(count);
  const hovered = active === null ? undefined : daily[active];

  return (
    <Panel role="region" aria-label={t("Daily tokens")} className="relative">
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--console-border)] px-[18px] py-2.5">
        <h3 className="text-sm font-semibold text-[var(--console-text)]">{t("Daily tokens")}</h3>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-[var(--console-muted)]">
            {kinds.map((kind) => (
              <li key={kind.key} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-[2px]", kind.swatch)} />
                {t(kind.label)}
              </li>
            ))}
            {hasCost ? (
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-[var(--console-text)]" />
                {t("API value")}
              </li>
            ) : null}
          </ul>
          <SegmentedControl
            size="sm"
            ariaLabel={t("Token scope")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: t("All") },
              { value: "fresh", label: t("Excluding cache reads") },
            ]}
          />
        </div>
      </div>

      <div className="px-[18px] pt-6 pb-[18px]">
        {count === 0 ? (
          <p className="py-10 text-center text-sm text-[var(--console-muted)]">
            {t("No usage data")}
          </p>
        ) : (
          <div className="grid grid-cols-[44px_minmax(0,1fr)_48px] gap-x-2.5">
            <div
              aria-hidden
              className="console-mono -mt-1.5 flex h-[252px] flex-col items-end justify-between text-[10px] leading-3 text-[var(--console-muted)]"
            >
              {TICKS.map((ratio) => (
                <span key={ratio}>{formatCompact(chart.tokenMax * ratio)}</span>
              ))}
            </div>

            <div
              className="relative border-b border-[var(--console-border-strong)]"
              style={{
                height: PLOT_HEIGHT,
                backgroundImage: "linear-gradient(var(--console-border) 1px, transparent 1px)",
                backgroundSize: `100% ${PLOT_HEIGHT / (TICKS.length - 1)}px`,
              }}
            >
              <div className="absolute inset-0 flex">
                {daily.map((bucket, index) => (
                  <div
                    key={bucket.date}
                    data-testid="overview-daily-column"
                    className={cn(
                      "flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5",
                      active === index
                        ? "bg-[var(--brand-soft)]"
                        : chart.days[index]!.weekend && count <= 31
                          ? "bg-[var(--console-surface-muted)]"
                          : null,
                    )}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                  >
                    {labelled && chart.totals[index]! > 0 ? (
                      <span className="console-mono text-[11px] font-medium text-[var(--console-text-secondary)] max-sm:hidden">
                        {formatCompact(chart.totals[index]!)}
                      </span>
                    ) : null}
                    <div
                      className={cn(
                        "flex flex-col-reverse gap-px",
                        labelled ? "w-[44%] max-w-[60px]" : "w-[70%]",
                      )}
                    >
                      {kinds.map((kind) =>
                        bucket[kind.key] > 0 ? (
                          <span
                            key={kind.key}
                            className={cn("block rounded-[2px] last:rounded-t-[6px]", kind.swatch)}
                            style={{
                              height: Math.max(
                                (bucket[kind.key] / chart.tokenMax) * PLOT_HEIGHT,
                                1.5,
                              ),
                            }}
                          />
                        ) : null,
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {chart.average > 0 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--console-text)]/40"
                  style={{ bottom: (chart.average / chart.tokenMax) * PLOT_HEIGHT }}
                >
                  <span className="console-mono absolute bottom-1 left-1.5 rounded-full bg-[var(--console-surface)] px-1.5 text-[10px] text-[var(--console-text-secondary)] shadow-[inset_0_0_0_1px_var(--console-border)]">
                    {t("Daily average {0}", [formatCompact(chart.average)])}
                  </span>
                </div>
              ) : null}

              {hasCost ? (
                <>
                  <svg
                    aria-hidden
                    viewBox={`0 0 ${count * 100} ${PLOT_HEIGHT}`}
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 h-full w-full"
                  >
                    <path
                      d={smoothPath(chart.costPoints)}
                      fill="none"
                      stroke="var(--console-text)"
                      strokeWidth="1.75"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {labelled
                    ? daily.map((bucket, index) => (
                        <span
                          key={bucket.date}
                          aria-hidden
                          className="pointer-events-none absolute size-[9px] -translate-x-1/2 translate-y-1/2 rounded-full bg-[var(--console-surface)] shadow-[inset_0_0_0_2px_var(--console-text)]"
                          style={{
                            left: `${((index + 0.5) / count) * 100}%`,
                            bottom: (bucket.cost / chart.costMax) * PLOT_HEIGHT,
                          }}
                        />
                      ))
                    : null}
                </>
              ) : null}

              <ChartKeyboardList
                label={t("Daily tokens chart")}
                itemLabels={chart.itemLabels}
                activeIndex={active}
                onActiveIndexChange={setActive}
                layout="columns"
              />

              {hovered && active !== null ? (
                <ChartTooltip index={active} count={count}>
                  <div className="flex justify-between gap-6 font-semibold">
                    <span>
                      {chart.days[active]!.label} {chart.days[active]!.weekday}
                    </span>
                    <span className="font-normal text-[var(--console-muted)]">
                      {t("{0} sessions", [formatInt(hovered.sessions)])}
                    </span>
                  </div>
                  {kinds.map((kind) => (
                    <div key={kind.key} className="mt-1 flex items-center gap-2">
                      <span aria-hidden className={cn("size-2 rounded-[2px]", kind.swatch)} />
                      {t(kind.label)}
                      <span className="ml-auto">{formatCompact(hovered[kind.key])}</span>
                    </div>
                  ))}
                  <div className="mt-1.5 flex justify-between gap-6 border-t border-[var(--console-border)] pt-1.5">
                    <span>{t("API value")}</span>
                    <span>{formatUsd(hovered.cost)}</span>
                  </div>
                </ChartTooltip>
              ) : null}
            </div>

            <div
              aria-hidden
              className="console-mono -mt-1.5 flex h-[252px] flex-col justify-between text-[10px] leading-3 text-[var(--console-muted)]"
            >
              {hasCost
                ? TICKS.map((ratio) => (
                    <span key={ratio}>{formatCostTick(chart.costMax * ratio)}</span>
                  ))
                : null}
            </div>

            <div aria-hidden className="col-start-2 flex pt-2 text-center">
              {chart.days.map((day, index) => (
                <span
                  key={daily[index]!.date}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col items-center",
                    ticks.size > 4 && (ticks.get(index) ?? 0) % 2 === 1 ? "max-sm:invisible" : null,
                  )}
                >
                  {ticks.has(index) ? (
                    <>
                      <span className="console-mono block text-[11px] font-medium whitespace-nowrap text-[var(--console-text)]">
                        {day.label}
                      </span>
                      {labelled ? (
                        <span className="block text-[10px] text-[var(--console-muted)]">
                          {day.weekday}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </span>
              ))}
            </div>

            <div className="sr-only">
              <table>
                <caption>{t("Daily tokens data")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("Date")}</th>
                    {TOKEN_KINDS.map((kind) => (
                      <th key={kind.key} scope="col">
                        {t(kind.label)}
                      </th>
                    ))}
                    <th scope="col">{t("API value")}</th>
                    <th scope="col">{t("Sessions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((bucket) => (
                    <tr key={bucket.date}>
                      <th scope="row">{formatMonthDay(bucket.date)}</th>
                      {TOKEN_KINDS.map((kind) => (
                        <td key={kind.key}>{formatInt(bucket[kind.key])}</td>
                      ))}
                      <td>{formatUsd(bucket.cost)}</td>
                      <td>{formatInt(bucket.sessions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
