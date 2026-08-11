/**
 * The chart surface for the tiled area plot: value axis, gridlines, the canvas
 * the field is painted on, and the scrubber that reads a single point off it.
 * The gridlines share the field's headroom, so a tick sits where its value sits.
 */
import { useRef, useState } from "react";

import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useTileField } from "../../hooks/useTileField";
import { HEADROOM, topFraction } from "../../lib/curve";
import { cn } from "../../lib/utils";
import { TILE_AXIS_WIDTH } from "./tile-bar-plot";

const TICK_FRACTIONS = [1, 0.66, 0.33, 0] as const;

const tickTop = (fraction: number) => `${(1 - fraction * (1 - HEADROOM)) * 100}%`;

/** The field reads point `i` at this fraction of the plot, so the marker has to
 *  sit there too or it would float beside its own curve. */
const pointLeft = (index: number, count: number) => ((index + 0.5) / count) * 100;

function Scrubber({
  values,
  max,
  labels,
  formatValue,
}: {
  values: number[];
  max: number;
  labels: string[];
  formatValue: (value: number) => string;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const track = (clientX: number) => {
    const rect = overlay.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const ratio = (clientX - rect.left) / rect.width;
    const nearest = Math.round(ratio * values.length - 0.5);
    setIndex(Math.min(values.length - 1, Math.max(0, nearest)));
  };

  const active = index !== null;
  const shown = index ?? 0;
  const value = values[shown] ?? 0;
  const chase = reducedMotion ? undefined : "left 260ms ease-out, top 260ms ease-out";

  return (
    <div
      ref={overlay}
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerMove={(event) => track(event.clientX)}
      onPointerLeave={() => setIndex(null)}
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-[var(--brand-line)] transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0",
        )}
        style={{ left: `${pointLeft(shown, values.length)}%`, transition: chase }}
      />
      <div
        className={cn(
          "pointer-events-none absolute size-0 transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0",
        )}
        style={{
          left: `${pointLeft(shown, values.length)}%`,
          top: `${topFraction(value, max) * 100}%`,
          transition: chase,
        }}
      >
        <span className="absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--brand)] ring-2 ring-[var(--console-surface)]" />
        <span className="console-mono absolute bottom-3 flex -translate-x-1/2 items-baseline gap-1.5 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 whitespace-nowrap shadow-[var(--shadow-overlay)]">
          <span className="text-[10px] text-[var(--console-muted)]">{labels[shown]}</span>
          <span className="text-[12px] font-semibold text-[var(--console-text)]">
            {formatValue(value)}
          </span>
        </span>
      </div>
    </div>
  );
}

export function TileAreaPlot({
  values,
  max,
  labels,
  height,
  formatValue,
  formatTick,
  className,
}: {
  values: number[];
  max: number;
  labels: string[];
  height: number;
  formatValue: (value: number) => string;
  /** Provide to render a value axis on the left; omit for a bare plot. */
  formatTick?: (value: number) => string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  useTileField(canvasRef, { values, max, reducedMotion });

  return (
    <div className={cn("flex", className)} aria-hidden>
      {formatTick ? (
        <div className="relative shrink-0" style={{ height, width: TILE_AXIS_WIDTH }}>
          {TICK_FRACTIONS.map((fraction) => (
            <span
              key={fraction}
              className="console-mono absolute right-2 -translate-y-1/2 text-[9.5px] whitespace-nowrap text-[var(--console-muted)]"
              style={{ top: tickTop(fraction) }}
            >
              {formatTick(max * fraction)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="chart-hatch relative min-w-0 flex-1" style={{ height }}>
        {TICK_FRACTIONS.map((fraction) => (
          <span
            key={fraction}
            className={cn(
              "pointer-events-none absolute inset-x-0",
              fraction === 0
                ? "h-px bg-[var(--console-border-strong)]"
                : "border-t border-dashed border-[var(--console-border)]",
            )}
            style={{ top: tickTop(fraction) }}
          />
        ))}
        <canvas ref={canvasRef} className="absolute inset-0 block" />
        {values.length > 0 ? (
          <Scrubber values={values} max={max} labels={labels} formatValue={formatValue} />
        ) : null}
      </div>
    </div>
  );
}
