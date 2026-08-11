/**
 * The tiled donut ring. The caller owns the legend and the centre figure; this
 * only draws the ring and reports which slice the pointer is over.
 */
import { useRef, type ReactNode } from "react";

import { useDonutRing } from "../../hooks/useDonutRing";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { ChartKeyboardList } from "./chart-keyboard-list";

export function TileDonut({
  shares,
  colors,
  hovered,
  onHover,
  size,
  ariaLabel,
  itemLabels,
  children,
}: {
  /** Fractions of the ring, in draw order; they should sum to 1. */
  shares: number[];
  colors: readonly string[];
  hovered: number | null;
  onHover: (index: number | null) => void;
  size: number;
  ariaLabel: string;
  itemLabels: readonly string[];
  /** Centre content, e.g. the total. */
  children?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { hitTest } = useDonutRing(canvasRef, { shares, colors, hovered, reducedMotion });

  return (
    <div
      className="relative shrink-0 touch-none"
      style={{ width: size, height: size }}
      onPointerMove={(event) => onHover(hitTest(event.clientX, event.clientY))}
      onPointerLeave={() => onHover(null)}
    >
      <canvas ref={canvasRef} aria-hidden className="block size-full" />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
      <ChartKeyboardList
        label={ariaLabel}
        itemLabels={itemLabels}
        activeIndex={hovered}
        onActiveIndexChange={onHover}
        layout="surface"
      />
    </div>
  );
}
