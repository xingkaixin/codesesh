import { useState, type CSSProperties } from "react";
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
  const slots = Array.from({ length: 12 }, (_, slot) => slot);
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
          <table
            data-active={active !== null ? "true" : undefined}
            className="mt-[14px] w-full table-fixed border-separate border-spacing-1 console-mono text-[10.5px] text-[var(--console-muted)]"
          >
            <caption className="sr-only">{t("Active hours")}</caption>
            <thead>
              <tr>
                <th scope="col" className="w-8 pb-1 text-left font-normal">
                  <span className="sr-only">{t("Time")}</span>
                </th>
                {slots.map((slot) => (
                  <th
                    key={slot}
                    scope="col"
                    className="pb-1 font-normal tabular-nums"
                    style={{
                      color:
                        active !== null && active % 12 === slot ? "var(--console-text)" : undefined,
                    }}
                  >
                    {String(slot * 2).padStart(2, "0")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekdays.map((day, row) => (
                <tr key={day}>
                  <th
                    scope="row"
                    className="text-left font-normal"
                    style={{
                      color:
                        active !== null && Math.floor(active / 12) === day
                          ? "var(--console-text)"
                          : undefined,
                    }}
                  >
                    {labels[row]}
                  </th>
                  {slots.map((slot) => {
                    const index = day * 12 + slot;
                    const count = activity.counts[index] ?? 0;
                    const scale = peak > 0 ? Math.sqrt(count / peak) : 0;
                    const summary = `${labels[row]} · ${hourRange(slot)} · ${t("{0} user messages", [formatInt(count)])}`;
                    return (
                      <td key={slot} className="relative p-0">
                        <button
                          type="button"
                          aria-label={summary}
                          className="activity-cell block h-7 w-full rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                          data-active={active === index ? "true" : undefined}
                          data-empty={count === 0 ? "true" : undefined}
                          style={
                            {
                              "--activity-color":
                                count > 0
                                  ? `color-mix(in oklab, var(--activity-high) ${20 + scale * 80}%, var(--console-surface))`
                                  : "var(--console-border)",
                            } as CSSProperties
                          }
                          onMouseEnter={() => setActive(index)}
                          onMouseLeave={() => setActive(null)}
                          onFocus={() => setActive(index)}
                          onBlur={() => setActive(null)}
                          onClick={() => setActive(index)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setActive(null);
                          }}
                        >
                          <span aria-hidden="true" className="activity-cell-tiles" />
                        </button>
                        {active === index ? (
                          <span
                            role="tooltip"
                            className={`pointer-events-none absolute bottom-full z-10 w-max max-w-[180px] rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-left text-[var(--console-text)] shadow-[var(--shadow-overlay)] ${slot < 6 ? "left-0" : "right-0"}`}
                          >
                            {`${labels[row]} · ${hourRange(slot)} · `}
                            <span className="font-semibold text-[var(--brand)]">
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
          <div className="mt-3 flex min-h-7 flex-wrap items-center justify-end gap-4 console-mono text-[10.5px] text-[var(--console-muted)]">
            {peak === 0 ? (
              <span>{t("No user messages in this range.")}</span>
            ) : (
              <>
                <span className="flex items-center gap-2">
                  {t("Less")}
                  <span
                    aria-hidden="true"
                    className="h-2 w-20 rounded-[2px]"
                    style={{
                      background:
                        "linear-gradient(to right in oklab, color-mix(in oklab, var(--activity-high) 20%, var(--console-surface)), var(--activity-high))",
                    }}
                  />
                  {t("More")}
                </span>
                <span>{t("Peak: {0}", [formatInt(peak)])}</span>
              </>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
