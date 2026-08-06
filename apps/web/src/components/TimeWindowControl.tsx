import { useState } from "react";
import { formatWindowLabel } from "../lib/scan-format";
import type { TimeWindow, TimeWindowPreset } from "../lib/time-window";
import { CustomTimeWindowDialog } from "./CustomTimeWindowDialog";

const PRESETS: Array<{ value: Exclude<TimeWindowPreset, "custom">; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export function TimeWindowControl({
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
  const [customOpen, setCustomOpen] = useState(false);
  const label = formatWindowLabel({ window });

  const openCustom = () => setCustomOpen(true);

  return (
    <>
      <div className="flex items-center gap-1">
        <label className="relative block">
          <span className="sr-only">Session time range</span>
          <select
            value={preset}
            title={label ?? "Session time range"}
            onChange={(event) => {
              const next = event.target.value as TimeWindowPreset;
              if (next === "custom") openCustom();
              else onSelectPreset(next);
            }}
            className="console-mono w-24 appearance-none rounded-full border border-[var(--console-border)] bg-[var(--console-surface)] py-[5px] pr-6 pl-[13px] text-[11px] text-[var(--console-text)] outline-none hover:border-[var(--console-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] sm:w-auto sm:max-w-44 sm:pr-7"
          >
            {PRESETS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </select>
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-[var(--console-muted)]">
            ▾
          </span>
        </label>
        {preset === "custom" ? (
          <button
            type="button"
            onClick={openCustom}
            aria-label="Edit custom time range"
            className="console-mono motion-hover motion-press rounded-full border border-[var(--brand)] bg-[var(--brand)] px-[13px] py-[5px] text-[11px] text-[var(--brand-fg)] hover:bg-[var(--brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)]"
          >
            Edit
          </button>
        ) : null}
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
