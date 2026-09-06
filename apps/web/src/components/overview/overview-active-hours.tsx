import { useState } from "react";
import type { DashboardActiveHours } from "@codesesh/core/contract";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { formatInt } from "../../lib/format";
import { Panel, PanelHeader } from "../ui/panel";

function hourRange(slot: number): string {
  return `${String(slot * 2).padStart(2, "0")}:00–${String(slot * 2 + 2).padStart(2, "0")}:00`;
}

export function OverviewActiveHours({ activity }: { activity: DashboardActiveHours | null }) {
  const locale = useLocale();
  const [active, setActive] = useState<number | null>(null);
  const weekdays = locale === "zh-CN" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const labels = weekdays.map((day) => formatter.format(Date.UTC(2026, 8, 6 + day)));
  const peak = Math.max(0, ...(activity?.counts ?? []));
  const total = activity?.counts.reduce((sum, count) => sum + count, 0) ?? 0;

  return (
    <Panel className="p-4" aria-label={t("Active hours")}>
      <PanelHeader title={t("Active hours")} />
      <p className="mt-1 text-xs text-[var(--console-muted)]">
        {t(
          "User messages by weekday and two-hour period. Counts are cumulative within the selected range.",
        )}
      </p>
      {!activity ? (
        <p className="py-8 text-center text-sm text-[var(--console-muted)]">
          {t("Activity data is unavailable.")}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 console-mono text-[10.5px] text-[var(--console-muted)]">
            <span>{t("Time zone: {0}", [activity.timeZone])}</span>
            <span>{t("{0} user messages", [formatInt(total)])}</span>
          </div>
          <table className="mt-3 w-full table-fixed border-collapse console-mono text-[10.5px] text-[var(--console-muted)]">
            <caption className="sr-only">{t("Active hours")}</caption>
            <thead>
              <tr>
                <th scope="col" className="w-[90px] pb-2 text-left font-normal">
                  {t("Time")}
                </th>
                {labels.map((label) => (
                  <th key={label} scope="col" className="pb-2 font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 12 }, (_, slot) => (
                <tr key={slot} className="border-t border-dashed border-[var(--console-border)]">
                  <th scope="row" className="h-8 text-left font-normal tabular-nums">
                    {hourRange(slot)}
                  </th>
                  {weekdays.map((day, column) => {
                    const index = day * 12 + slot;
                    const count = activity.counts[index] ?? 0;
                    const summary = `${labels[column]} · ${hourRange(slot)} · ${t("{0} user messages", [formatInt(count)])}`;
                    return (
                      <td key={day} className="relative p-0 text-center">
                        <button
                          type="button"
                          aria-label={summary}
                          className="flex h-8 w-full items-center justify-center rounded-sm outline-none hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--console-text)]"
                          onMouseEnter={() => setActive(index)}
                          onMouseLeave={() => setActive(null)}
                          onFocus={() => setActive(index)}
                          onBlur={() => setActive(null)}
                          onClick={() => setActive(index)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setActive(null);
                          }}
                        >
                          <svg
                            width="28"
                            height="28"
                            viewBox="0 0 28 28"
                            aria-hidden="true"
                            className="text-[var(--console-text)]"
                          >
                            {count > 0 ? (
                              <circle
                                cx="14"
                                cy="14"
                                r={12 * Math.sqrt(count / peak)}
                                fill="currentColor"
                                opacity="0.75"
                              />
                            ) : null}
                          </svg>
                        </button>
                        {active === index ? (
                          <span
                            role="tooltip"
                            className={`pointer-events-none absolute bottom-full z-10 w-max max-w-[180px] rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-left text-[var(--console-text)] shadow-[var(--shadow-overlay)] ${column < 3 ? "left-0" : "right-0"}`}
                          >
                            {summary}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex min-h-7 flex-wrap items-center justify-end gap-4 console-mono text-[10.5px] text-[var(--console-muted)]">
            {peak === 0 ? (
              <span>{t("No user messages in this range.")}</span>
            ) : (
              <>
                <span>{t("Circle area represents message count")}</span>
                <span className="flex items-center gap-4">
                  {[
                    ...new Set([
                      Math.max(1, Math.round(peak / 4)),
                      Math.max(1, Math.round(peak / 2)),
                      peak,
                    ]),
                  ].map((count) => (
                    <span key={count} className="flex items-center gap-1.5">
                      <svg
                        width="28"
                        height="28"
                        viewBox="0 0 28 28"
                        aria-hidden="true"
                        className="text-[var(--console-text)]"
                      >
                        <circle
                          cx="14"
                          cy="14"
                          r={12 * Math.sqrt(count / peak)}
                          fill="currentColor"
                          opacity="0.75"
                        />
                      </svg>
                      {formatInt(count)}
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
