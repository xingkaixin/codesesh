import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { formatIsoDate, formatWindowLabel } from "../lib/scan-format";
import type { TimeWindow, TimeWindowPreset } from "../lib/time-window";

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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const label = formatWindowLabel({ window });

  const openCustom = () => {
    setFrom(customFrom ?? (window.from != null ? formatIsoDate(window.from) : ""));
    setTo(customTo ?? formatIsoDate(window.to ?? Date.now()));
    setCustomOpen(true);
  };

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
            className="console-mono w-24 appearance-none rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] py-1 pr-6 pl-2 text-xs text-[var(--console-text)] outline-none hover:border-[var(--console-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 sm:w-auto sm:max-w-44 sm:pr-7"
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
            className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-1 text-xs text-[var(--console-muted)] hover:border-[var(--console-border-strong)] hover:text-[var(--console-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2"
          >
            Edit
          </button>
        ) : null}
      </div>

      <Dialog.Root open={customOpen} onOpenChange={setCustomOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-black/35" />
          <Dialog.Popup className="motion-modal fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] p-5 shadow-2xl outline-none">
            <Dialog.Title className="console-mono text-sm font-semibold text-[var(--console-text)]">
              Custom time range
            </Dialog.Title>
            <p className="mt-1 text-xs text-[var(--console-muted)]">Both dates are included.</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="console-mono text-[11px] uppercase tracking-wide text-[var(--console-muted)]">
                From
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-1.5 w-full rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-2 text-xs normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--console-accent)] focus:ring-2 focus:ring-[var(--console-accent)]/25"
                />
              </label>
              <label className="console-mono text-[11px] uppercase tracking-wide text-[var(--console-muted)]">
                To
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-1.5 w-full rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-2 text-xs normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--console-accent)] focus:ring-2 focus:ring-[var(--console-accent)]/25"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                disabled={!from || !to || from > to}
                onClick={() => {
                  onSelectCustom(from, to);
                  setCustomOpen(false);
                }}
                className="rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-text)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply range
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
