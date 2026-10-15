import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import type { TimeWindow, TimeWindowPreset } from "../../lib/time-window";
import { cn } from "../../lib/utils";
import { CustomTimeWindowDialog } from "../CustomTimeWindowDialog";

const PRESETS: readonly { value: TimeWindowPreset; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "14d", label: "14d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

function monthDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function TimeRangeControl({
  window,
  preset,
  customFrom,
  customTo,
  onSelectPreset,
  onSelectCustom,
}: {
  window: TimeWindow;
  preset: TimeWindowPreset;
  customFrom?: string;
  customTo?: string;
  onSelectPreset: (preset: TimeWindowPreset) => void;
  onSelectCustom: (from: string, to: string) => void;
}) {
  useLocale();
  const [customOpen, setCustomOpen] = useState(false);
  const bounded = window.days !== 0 && window.from != null && window.to != null;

  return (
    <>
      {bounded ? (
        <span className="console-mono hidden text-[11px] text-[var(--console-muted)] sm:inline">
          {monthDay(window.from!)} → {monthDay(window.to!)}
        </span>
      ) : null}
      <div
        role="group"
        aria-label={t("Session time range")}
        className="inline-flex gap-0.5 rounded-[10px] bg-[var(--console-sidebar-bg)] p-[3px]"
      >
        {PRESETS.map((option) => {
          const selected = option.value === preset;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              aria-haspopup={option.value === "custom" ? "dialog" : undefined}
              onClick={() => {
                if (option.value === "custom") setCustomOpen(true);
                else onSelectPreset(option.value);
              }}
              className={cn(
                "motion-hover h-[26px] rounded-md px-2.5 text-xs font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none sm:px-3",
                selected
                  ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-[var(--shadow-raised)]"
                  : "text-[var(--console-muted)] hover:text-[var(--console-text)]",
              )}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
      <CustomTimeWindowDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        window={window}
        customFrom={customFrom}
        customTo={customTo}
        onSelectCustom={onSelectCustom}
      />
    </>
  );
}
