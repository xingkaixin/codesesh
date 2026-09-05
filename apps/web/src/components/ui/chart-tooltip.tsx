import type { ReactNode } from "react";

export function ChartTooltip({
  index,
  count,
  children,
}: {
  index: number;
  count: number;
  children: ReactNode;
}) {
  const position = ((index + 0.5) / count) * 100;

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
