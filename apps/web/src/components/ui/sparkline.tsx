/** Bar sparkline for per-row trends (e.g. a project's last 14 days of spend). */
export function Sparkline({
  values,
  width = 74,
  height = 20,
  barWidth = 3,
  gap = 2,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  barWidth?: number;
  gap?: number;
  label: string;
}) {
  const max = values.reduce((peak, value) => Math.max(peak, value), 0);

  return (
    <div role="img" aria-label={label} className="flex items-end" style={{ width, height, gap }}>
      {values.map((value, index) => (
        <span
          key={index}
          className="rounded-[2px] bg-[var(--console-border-strong)]"
          style={{
            width: barWidth,
            // 2px floor: an empty day must still read as a baseline tick, not a gap.
            height: max > 0 ? Math.max(2, Math.round((value / max) * height)) : 2,
          }}
        />
      ))}
    </div>
  );
}
