import type { ReactNode } from "react";

export function ChartTooltip({
  index,
  count,
  position = ((index + 0.5) / count) * 100,
  children,
}: {
  index: number;
  count: number;
  position?: number;
  children: ReactNode;
}) {
  return (
    <div
      role="tooltip"
      className="console-mono pointer-events-none absolute top-2 z-10 w-max max-w-full rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-2 text-[10.5px] break-words text-[var(--console-text)] shadow-[var(--shadow-overlay)]"
      style={{ left: `${position}%`, transform: `translateX(-${position}%)` }}
    >
      {children}
    </div>
  );
}
