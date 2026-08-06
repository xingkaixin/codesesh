/** Proportion bars: a single-track share (rank rows) and a stacked composition. */
import { cn } from "../../lib/utils";

export function ShareBar({
  ratio,
  tone = "brand",
  className,
}: {
  ratio: number;
  tone?: "brand" | "neutral";
  className?: string;
}) {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;

  return (
    <div
      className={cn(
        "h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--console-surface-sunken)]",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full",
          tone === "brand" ? "bg-[var(--brand)]" : "bg-[var(--console-border-strong)]",
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

export interface ShareSegment {
  key: string;
  value: number;
  color: string;
}

export function StackedShareBar({
  segments,
  height = 9,
  label,
}: {
  segments: ShareSegment[];
  height?: number;
  label: string;
}) {
  const percents = segmentPercents(segments.map((segment) => Math.max(0, segment.value)));

  return (
    <div
      role="img"
      aria-label={label}
      className="flex overflow-hidden rounded-full bg-[var(--console-surface-sunken)]"
      style={{ height }}
    >
      {segments.map((segment, index) => (
        <span
          key={segment.key}
          style={{ width: `${percents[index]}%`, background: segment.color }}
        />
      ))}
    </div>
  );
}

/** Widths in percent, tracked in basis points so the last segment absorbs the
 *  rounding error and the row always covers exactly 100%. */
function segmentPercents(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);

  let used = 0;
  return values.map((value, index) => {
    if (index === values.length - 1) return (10000 - used) / 100;
    const basisPoints = Math.round((value / total) * 10000);
    used += basisPoints;
    return basisPoints / 100;
  });
}
