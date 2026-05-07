import { useEffect, useId, useRef, useState } from "react";
import type { TimeRange } from "../lib/api";
import {
  formatLocalIsoDate,
  formatRangeLabel,
  isValidIsoDate,
} from "../lib/useTimeRange";

interface PresetOption {
  label: string;
  range: TimeRange;
}

const PRESETS: PresetOption[] = [
  { label: "Yesterday", range: { kind: "yesterday" } },
  { label: "Last 1 day", range: { kind: "preset", days: 1 } },
  { label: "Last 3 days", range: { kind: "preset", days: 3 } },
  { label: "Last 7 days", range: { kind: "preset", days: 7 } },
  { label: "Last 14 days", range: { kind: "preset", days: 14 } },
  { label: "Last 30 days", range: { kind: "preset", days: 30 } },
  { label: "Last 90 days", range: { kind: "preset", days: 90 } },
  { label: "All time", range: { kind: "all" } },
];

function rangesEqual(a: TimeRange | null, b: TimeRange): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "preset" && b.kind === "preset") return a.days === b.days;
  if (a.kind === "all" && b.kind === "all") return true;
  if (a.kind === "yesterday" && b.kind === "yesterday") return true;
  if (a.kind === "custom" && b.kind === "custom")
    return a.from === b.from && (a.to ?? "") === (b.to ?? "");
  return false;
}

export interface TimeRangeMenuProps {
  range: TimeRange | null;
  onChange: (next: TimeRange | null) => void;
  /** When true, current value is the CLI fallback, not URL state. */
  isFallback: boolean;
}

export function TimeRangeMenu({ range, onChange, isFallback }: TimeRangeMenuProps) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState<string>(() =>
    range?.kind === "custom" ? range.from : formatLocalIsoDate(Date.now() - 7 * 86400000),
  );
  const [draftTo, setDraftTo] = useState<string>(() =>
    range?.kind === "custom" ? (range.to ?? "") : formatLocalIsoDate(Date.now()),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const customId = useId();

  // Sync draft fields when external range changes (e.g. fallback updates after config load).
  useEffect(() => {
    if (range?.kind === "custom") {
      setDraftFrom(range.from);
      setDraftTo(range.to ?? "");
    }
  }, [range]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current) return;
      if (event.target instanceof Node && containerRef.current.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const buttonLabel = formatRangeLabel(range);
  const customDraftValid =
    isValidIsoDate(draftFrom) && (draftTo === "" || isValidIsoDate(draftTo));

  function handlePresetSelect(option: PresetOption) {
    onChange(option.range);
    setOpen(false);
  }

  function handleCustomApply() {
    if (!customDraftValid) return;
    onChange({
      kind: "custom",
      from: draftFrom,
      to: draftTo === "" ? undefined : draftTo,
    });
    setOpen(false);
  }

  function handleClear() {
    onChange(null);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Filter sessions, dashboard, and search by activity time"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="console-mono inline-flex items-center gap-1.5 rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <span>{buttonLabel}</span>
        {isFallback ? (
          <span className="text-[10px] text-[var(--console-muted)]">·CLI</span>
        ) : null}
        <span aria-hidden="true" className="text-[9px] text-[var(--console-muted)]">
          ▼
        </span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Time range filter"
          className="absolute right-0 z-40 mt-1 w-72 rounded-sm border border-[var(--console-border-strong)] bg-white p-3 shadow-lg"
        >
          <div role="radiogroup" aria-label="Preset ranges" className="space-y-1">
            {PRESETS.map((option) => {
              const active = rangesEqual(range, option.range);
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handlePresetSelect(option)}
                  className={`console-mono flex w-full items-center justify-between rounded-sm border px-2 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? "border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] text-[var(--console-text)]"
                      : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                  }`}
                >
                  <span>{option.label}</span>
                  {active ? <span className="text-[10px]">✓</span> : null}
                </button>
              );
            })}
          </div>
          <div className="mt-3 border-t border-[var(--console-border)] pt-3">
            <p className="console-mono text-[10px] uppercase tracking-wide text-[var(--console-muted)]">
              Custom range
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="console-mono flex flex-col gap-1 text-[11px] text-[var(--console-muted)]">
                <span>From</span>
                <input
                  id={`${customId}-from`}
                  type="date"
                  value={draftFrom}
                  onChange={(event) => setDraftFrom(event.target.value)}
                  className="rounded-sm border border-[var(--console-border)] bg-white px-1.5 py-1 text-xs text-[var(--console-text)] outline-none focus:border-[var(--console-border-strong)]"
                />
              </label>
              <label className="console-mono flex flex-col gap-1 text-[11px] text-[var(--console-muted)]">
                <span>To (optional)</span>
                <input
                  id={`${customId}-to`}
                  type="date"
                  value={draftTo}
                  onChange={(event) => setDraftTo(event.target.value)}
                  className="rounded-sm border border-[var(--console-border)] bg-white px-1.5 py-1 text-xs text-[var(--console-text)] outline-none focus:border-[var(--console-border-strong)]"
                />
              </label>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleClear}
                className="console-mono rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-[11px] text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={handleCustomApply}
                disabled={!customDraftValid}
                className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
