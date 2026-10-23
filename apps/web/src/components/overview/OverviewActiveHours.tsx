import { useId, useState } from "react";
import type { DashboardActiveHours } from "@codesesh/contract";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { smoothPath, type ChartPoint } from "../../lib/chart-scale";
import { formatInt, formatShare } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel } from "../ui/panel";

const SLOTS = 12;
const CURVE_HEIGHT = 48;
/** Overnight, morning, afternoon, evening: three two-hour slots each. */
const PERIODS = ["Overnight", "Morning", "Afternoon", "Evening"] as const;

function hourRange(slot: number): string {
  return `${String(slot * 2).padStart(2, "0")}:00–${String(slot * 2 + 2).padStart(2, "0")}:00`;
}

/** Area follows the count; the 4px floor keeps a single message visible. */
function dotSize(count: number, peak: number): number {
  return peak > 0 && count > 0 ? Math.max(4, 18 * Math.sqrt(count / peak)) : 0;
}

function dotColor(count: number, peak: number): string {
  const strength = Math.round(30 + Math.sqrt(count / peak) * 70);
  return strength >= 100
    ? "var(--brand)"
    : `color-mix(in oklab, var(--brand) ${strength}%, var(--console-surface))`;
}

function Dot({ count, peak, isPeak }: { count: number; peak: number; isPeak?: boolean }) {
  const size = dotSize(count, peak);
  if (size === 0) {
    return (
      <span aria-hidden className="size-[3px] rounded-full bg-[var(--console-border-strong)]" />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "rounded-full",
        isPeak ? "shadow-[0_0_0_2px_var(--console-surface),0_0_0_3.5px_var(--console-text)]" : null,
      )}
      style={{ width: size, height: size, background: dotColor(count, peak) }}
    />
  );
}

export function OverviewActiveHours({ activity }: { activity: DashboardActiveHours | null }) {
  const locale = useLocale();
  const gradient = useId();
  const [active, setActive] = useState<number | null>(null);
  const weekdays = locale === "zh-CN" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const labels = weekdays.map((day) => formatter.format(Date.UTC(2026, 8, 6 + day)));
  const counts = activity?.counts ?? [];
  const peak = Math.max(0, ...counts);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const peakIndex = peak > 0 ? counts.indexOf(peak) : -1;

  const bySlot = Array.from({ length: SLOTS }, (_, slot) =>
    weekdays.reduce((sum, day) => sum + (counts[day * SLOTS + slot] ?? 0), 0),
  );
  const slotPeak = Math.max(0, ...bySlot);
  const curve = smoothPath(
    bySlot.map((count, slot): ChartPoint => [
      slot * 10 + 5,
      CURVE_HEIGHT - 2 - (slotPeak > 0 ? count / slotPeak : 0) * (CURVE_HEIGHT - 6),
    ]),
  );
  const share = (slots: readonly number[], days: readonly number[] = weekdays) =>
    total > 0
      ? days.reduce(
          (sum, day) =>
            sum + slots.reduce((acc, slot) => acc + (counts[day * SLOTS + slot] ?? 0), 0),
          0,
        ) / total
      : 0;
  const allSlots = Array.from({ length: SLOTS }, (_, slot) => slot);

  return (
    <Panel aria-label={t("Active hours")} className="relative">
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--console-border)] px-[18px] py-2.5">
        <h3 className="text-sm font-semibold text-[var(--console-text)]">{t("Active hours")}</h3>
        {activity ? (
          <span className="ml-auto text-xs text-[var(--console-muted)]">
            {t("Time zone: {0}", [activity.timeZone])} ·{" "}
            {t("{0} user messages", [formatInt(total)])}
          </span>
        ) : null}
      </div>
      {!activity ? (
        <p className="py-10 text-center text-sm text-[var(--console-muted)]">
          {t("Activity data is unavailable.")}
        </p>
      ) : (
        <div className="grid gap-8 p-[18px] md:grid-cols-[minmax(0,1fr)_200px]">
          <div className="min-w-0">
            <div aria-hidden className="grid grid-cols-[40px_minmax(0,1fr)]">
              <span className="self-end pb-1 text-[11px] text-[var(--console-muted)]">
                {t("Total")}
              </span>
              <svg
                viewBox={`0 0 ${SLOTS * 10} ${CURVE_HEIGHT}`}
                preserveAspectRatio="none"
                className="block h-12 w-full"
              >
                <defs>
                  <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--brand)" stopOpacity="0.26" />
                    <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {slotPeak > 0 ? (
                  <>
                    <path
                      d={`${curve} L${SLOTS * 10 - 5} ${CURVE_HEIGHT} L5 ${CURVE_HEIGHT} Z`}
                      fill={`url(#${gradient})`}
                    />
                    <path
                      d={curve}
                      fill="none"
                      stroke="var(--brand)"
                      strokeWidth="1.75"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                ) : null}
              </svg>
            </div>
            <table className="mt-1 w-full table-fixed border-collapse">
              <caption className="sr-only">{t("Active hours")}</caption>
              <colgroup>
                <col className="w-10" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t("Weekday")}</span>
                  </th>
                  {allSlots.map((slot) => (
                    <th
                      key={slot}
                      scope="col"
                      className="console-mono pb-1 text-left text-[10px] font-normal text-[var(--console-muted)]"
                    >
                      {slot % 2 === 0 ? String(slot * 2).padStart(2, "0") : null}
                      <span className="sr-only">{slot % 2 === 0 ? null : hourRange(slot)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weekdays.map((day, row) => (
                  <tr key={day}>
                    <th
                      scope="row"
                      className="text-left text-[11px] font-normal text-[var(--console-muted)]"
                    >
                      {labels[row]}
                    </th>
                    {allSlots.map((slot) => {
                      const index = day * SLOTS + slot;
                      const count = counts[index] ?? 0;
                      const summary = `${labels[row]} · ${hourRange(slot)} · ${t("{0} user messages", [formatInt(count)])}`;
                      return (
                        <td key={slot} className="relative p-0">
                          <button
                            type="button"
                            aria-label={summary}
                            className="flex h-7 w-full items-center justify-center rounded-sm outline-none hover:bg-[var(--brand-soft)] focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                            onMouseEnter={() => setActive(index)}
                            onMouseLeave={() => setActive(null)}
                            onFocus={() => setActive(index)}
                            onBlur={() => setActive(null)}
                            onClick={() => setActive(index)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setActive(null);
                            }}
                          >
                            <Dot count={count} peak={peak} isPeak={index === peakIndex} />
                          </button>
                          {active === index ? (
                            <span
                              role="tooltip"
                              className={cn(
                                "pointer-events-none absolute bottom-full z-10 w-max max-w-[180px] rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-left text-[11px] text-[var(--console-text)] shadow-[var(--shadow-overlay)]",
                                slot < SLOTS / 2 ? "left-0" : "right-0",
                              )}
                            >
                              {`${labels[row]} · ${hourRange(slot)} · `}
                              <span className="font-semibold text-[var(--brand-ink)]">
                                {t("{0} user messages", [formatInt(count)])}
                              </span>
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex min-h-6 flex-wrap items-center justify-end gap-4 text-[11px] text-[var(--console-muted)]">
              {peak === 0 ? (
                <span>{t("No user messages in this range.")}</span>
              ) : (
                <span
                  className="flex items-center gap-1.5"
                  aria-label={t("Size reference (messages)")}
                >
                  {t("Less")}
                  {[1, 4, 9].map((count) => (
                    <Dot key={count} count={count} peak={9} />
                  ))}
                  {t("More")}
                </span>
              )}
            </div>
          </div>

          {peak > 0 ? (
            <div className="flex flex-col gap-3.5">
              <div className="rounded-lg bg-[var(--brand-soft)] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--brand-line)]">
                <p className="text-[11px] font-medium text-[var(--brand-ink)]">
                  {t("Most active")}
                </p>
                <p className="console-mono mt-0.5 text-base text-[var(--console-text)]">
                  {labels[weekdays.indexOf(Math.floor(peakIndex / SLOTS))]}{" "}
                  {hourRange(peakIndex % SLOTS)}
                </p>
                <p className="text-[11px] text-[var(--console-muted)]">
                  {t("{0} user messages", [formatInt(peak)])}
                </p>
              </div>
              <dl className="flex flex-col gap-3 text-xs">
                {PERIODS.map((period, group) => {
                  const ratio = share([group * 3, group * 3 + 1, group * 3 + 2]);
                  return (
                    <div key={period}>
                      <div className="flex justify-between gap-2">
                        <dt className="text-[var(--console-text-secondary)]">{t(period)}</dt>
                        <dd className="console-mono text-[var(--console-text)]">
                          {formatShare(ratio)}
                        </dd>
                      </div>
                      <div
                        aria-hidden
                        className="mt-1 h-1 rounded-full bg-[var(--console-sidebar-accent)]"
                      >
                        <span
                          className="block h-full rounded-full bg-[var(--console-text-secondary)]"
                          style={{ width: `${ratio * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                <div className="flex justify-between gap-2 border-t border-[var(--console-border)] pt-3">
                  <dt className="text-[var(--console-text-secondary)]">{t("Weekend")}</dt>
                  <dd className="console-mono text-[var(--console-text)]">
                    {formatShare(share(allSlots, [0, 6]))}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
