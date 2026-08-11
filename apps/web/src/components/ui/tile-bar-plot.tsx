/**
 * The chart surface for every bar chart on the dashboard: dashed gridlines, an
 * optional value axis and the tiled canvas that does the actual drawing.
 *
 * It renders no labels and no tooltip — the card that owns the data owns those,
 * because a day column and an agent column read very differently.
 */
import { useEffect, useRef } from "react";

import {
  DEFAULT_BAR_LAYOUT,
  useBarField,
  type BarFieldLayout,
  type BarHover,
} from "../../hooks/useBarField";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { cn } from "../../lib/utils";
import { ChartKeyboardList } from "./chart-keyboard-list";

const TICK_FRACTIONS = [1, 0.75, 0.5, 0.25, 0] as const;

/** Exported so a card can indent anything that must line up with the plot. */
export const TILE_AXIS_WIDTH = 38;

function sameHover(left: BarHover | null, right: BarHover | null): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.column === right.column && left.band === right.band)
  );
}

export function TileBarPlot({
  values,
  axisMax,
  colors,
  highlight = "var(--brand)",
  hovered,
  onHover,
  layout,
  height,
  formatTick,
  ariaLabel,
  itemLabels,
  className,
}: {
  /** `[column][band]`; a plain bar chart is one band per column. */
  values: number[][];
  axisMax: number;
  colors: readonly string[];
  highlight?: string;
  hovered: BarHover | null;
  onHover: (hover: BarHover | null) => void;
  layout?: Partial<BarFieldLayout>;
  height: number;
  /** Provide to render a value axis on the left; omit for a bare plot. */
  formatTick?: (value: number) => string;
  ariaLabel: string;
  itemLabels: readonly string[];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reportedHover = useRef<BarHover | null>(hovered);
  const reducedMotion = usePrefersReducedMotion();
  const { hitTest } = useBarField(canvasRef, {
    values,
    axisMax,
    colors,
    highlight,
    hovered,
    layout: { ...DEFAULT_BAR_LAYOUT, ...layout },
    reducedMotion,
  });
  useEffect(() => {
    reportedHover.current = hovered;
  }, [hovered]);

  const reportHover = (nextHover: BarHover | null) => {
    if (sameHover(reportedHover.current, nextHover)) return;
    reportedHover.current = nextHover;
    onHover(nextHover);
  };

  return (
    <div className={cn("flex", className)}>
      {formatTick ? (
        <div className="relative shrink-0" style={{ height, width: TILE_AXIS_WIDTH }} aria-hidden>
          {TICK_FRACTIONS.map((fraction) => (
            <span
              key={fraction}
              className="console-mono absolute right-2 -translate-y-1/2 text-[9.5px] whitespace-nowrap text-[var(--console-muted)]"
              style={{ top: `${(1 - fraction) * 100}%` }}
            >
              {formatTick(axisMax * fraction)}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className="chart-hatch relative min-w-0 flex-1 touch-none"
        style={{ height }}
        onPointerMove={(event) => reportHover(hitTest(event.clientX, event.clientY))}
        onPointerLeave={() => reportHover(null)}
      >
        {TICK_FRACTIONS.map((fraction) => (
          <span
            key={fraction}
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0",
              fraction === 0
                ? "h-px bg-[var(--console-border-strong)]"
                : "border-t border-dashed border-[var(--console-border)]",
            )}
            style={{ top: `${(1 - fraction) * 100}%` }}
          />
        ))}
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 block" />
        <ChartKeyboardList
          label={ariaLabel}
          itemLabels={itemLabels}
          activeIndex={hovered?.column ?? null}
          onActiveIndexChange={(column) =>
            reportHover(column === null ? null : { column, band: null })
          }
          layout="columns"
        />
      </div>
    </div>
  );
}
