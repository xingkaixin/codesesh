import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { formatIsoDate } from "../lib/scan-format";
import type { TimeWindow } from "../lib/time-window";

export function CustomTimeWindowDialog({
  open,
  onOpenChange,
  window,
  customFrom,
  customTo,
  onSelectCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  window: TimeWindow | null;
  customFrom?: string;
  customTo?: string;
  onSelectCustom: (from: string, to: string) => void;
}) {
  const initialFrom = customFrom ?? (window?.from != null ? formatIsoDate(window.from) : "");
  const initialTo = customTo ?? formatIsoDate(window?.to ?? Date.now());
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);

  useEffect(() => {
    if (open) return;
    setFrom(initialFrom);
    setTo(initialTo);
  }, [initialFrom, initialTo, open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-[var(--scrim)]" />
        <Dialog.Popup className="motion-modal fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-5 shadow-[var(--shadow-overlay)] outline-none">
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
                className="mt-1.5 w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2 py-2 text-xs normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/25"
              />
            </label>
            <label className="console-mono text-[11px] uppercase tracking-wide text-[var(--console-muted)]">
              To
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1.5 w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2 py-2 text-xs normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/25"
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
                onOpenChange(false);
              }}
              className="rounded-sm border border-[var(--console-accent)] bg-[var(--console-accent)] px-3 py-1.5 text-xs text-[var(--console-accent-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply range
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
