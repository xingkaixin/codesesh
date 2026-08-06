/**
 * The sub-sessions of one timeline row, rendered inside the parent card so a
 * child never gets its own slot on the day axis.
 */
import type { SessionReference } from "@codesesh/core/contract";
import { formatClockTime, formatInt, formatUsd } from "../../lib/format";
import type { TimelineChildRow } from "../../lib/session-timeline";

export function TimelineChildPanel({
  id,
  rows,
  onOpen,
}: {
  id: string;
  rows: TimelineChildRow[];
  onOpen: (reference: SessionReference) => void;
}) {
  return (
    <div
      id={id}
      // The 66px inset lines the child list up with the parent's title column.
      className="border-t border-dashed border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] p-[10px_16px_12px_66px]"
    >
      <span className="console-eyebrow">Sub-sessions · derived from this session</span>
      <div className="mt-2 flex flex-col gap-1.5 border-l border-dashed border-[var(--console-border-strong)] pl-[14px]">
        {rows.map((child) => (
          <button
            key={child.routeKey}
            type="button"
            onClick={() => onOpen(child.reference)}
            className="motion-hover flex items-center gap-[11px] rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-[9px_12px] text-left hover:border-[var(--console-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <span className="console-mono w-[34px] shrink-0 text-[10px] text-[var(--console-muted)]">
              {formatClockTime(child.time)}
            </span>
            {child.kind == null ? null : (
              <span className="console-mono shrink-0 rounded-sm border border-[var(--console-border)] px-1.5 text-[9.5px] text-[var(--console-muted)]">
                {child.kind}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--console-text)]">
              {child.title}
            </span>
            <span className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]">
              {formatInt(child.messageCount)} msgs · {formatUsd(child.cost)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
