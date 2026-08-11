/**
 * Paints a donut onto a canvas with the same drifting tiles as the bars, and
 * hit-tests pointer positions back to a slice.
 *
 * The displayed angles are the source of truth, so a data change eases from
 * whatever is on screen right now, mid-flight included.
 */
import { useContext, useEffect, useRef, type RefObject } from "react";

import {
  clamp01,
  hashUnit,
  resolveColor,
  smoothstep,
  TAU,
  tileWave,
  withAlpha,
} from "../lib/chart-shading";
import { useCanvasFrameLoop } from "./useCanvasFrameLoop";
import { ResolvedThemeContext } from "./useTheme";

/** The ring lives in a fixed 200×200 space, so the tile grid never depends on
 *  the rendered size and can be built once for the module. */
const LOGICAL = 200;
const CX = 100;
const CY = 100;
const R_OUTER = 86;
const R_INNER = 55;
const START = -Math.PI / 2;
const GAP = 0.07;
const CORNER = 6;
const CELL = 4.6;
const MAX_DPR = 2;

const DRIFT_RATE = 0.0018;
const MORPH_MS = 500;
const EXPLODE = 6;
const BASE_ALPHA = 0.72;
const DIM = 0.3;

interface Tile {
  x: number;
  y: number;
  angle: number;
  fullness: number;
  jitter: number;
}

const TILES: Tile[] = (() => {
  const tiles: Tile[] = [];
  for (let x = CX - R_OUTER; x <= CX + R_OUTER; x += CELL) {
    for (let y = CY - R_OUTER; y <= CY + R_OUTER; y += CELL) {
      const dx = x - CX;
      const dy = y - CY;
      const distance = Math.hypot(dx, dy);
      if (distance < R_INNER - CELL || distance > R_OUTER + CELL) continue;
      tiles.push({
        x,
        y,
        angle: Math.atan2(dy, dx),
        fullness: 0.62 + 0.38 * smoothstep((distance - R_INNER) / (R_OUTER - R_INNER)),
        jitter: hashUnit(x, y),
      });
    }
  }
  return tiles;
})();

interface Arc {
  a0: number;
  a1: number;
}

/** Annular wedge with all four corners rounded, clamped so they never overlap. */
function traceSlice(ctx: CanvasRenderingContext2D, { a0, a1 }: Arc) {
  const sweep = a1 - a0;
  const radius = Math.min(CORNER, (R_OUTER - R_INNER) * 0.45, R_INNER * sweep * 0.45);
  const outerInset = radius / R_OUTER;
  const innerInset = radius / R_INNER;
  const at = (r: number, angle: number): [number, number] => [
    CX + Math.cos(angle) * r,
    CY + Math.sin(angle) * r,
  ];

  const [sx, sy] = at(R_OUTER, a0 + outerInset);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.arc(CX, CY, R_OUTER, a0 + outerInset, a1 - outerInset);
  ctx.arcTo(...at(R_OUTER, a1), ...at(R_INNER, a1), radius);
  ctx.arcTo(...at(R_INNER, a1), ...at(R_INNER, a1 - innerInset), radius);
  ctx.arc(CX, CY, R_INNER, a1 - innerInset, a0 + innerInset, true);
  ctx.arcTo(...at(R_INNER, a0), ...at(R_OUTER, a0), radius);
  ctx.arcTo(...at(R_OUTER, a0), sx, sy, radius);
  ctx.closePath();
}

function arcsFrom(shares: readonly number[]): Arc[] {
  let cursor = START;
  return shares.map((share) => {
    const sweep = share * TAU;
    const arc = { a0: cursor + GAP / 2, a1: cursor + sweep - GAP / 2 };
    cursor += sweep;
    return arc;
  });
}

interface Options {
  shares: number[];
  colors: readonly string[];
  hovered: number | null;
  reducedMotion: boolean;
}

export function useDonutRing(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  { shares, colors, hovered, reducedMotion }: Options,
) {
  const theme = useContext(ResolvedThemeContext);
  const frameLoop = useCanvasFrameLoop(canvasRef, reducedMotion);
  const colorsKey = colors.join("\0");
  const hoveredRef = useRef(hovered);

  const morph = useRef({
    displayed: shares.slice(),
    from: shares.slice(),
    target: shares.slice(),
    startedAt: 0,
    running: false,
  });
  const arcs = useRef<Arc[]>(arcsFrom(shares));
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const current = morph.current;
    current.from = current.displayed.slice();
    current.target = shares.slice();
    if (reducedMotion) {
      current.displayed = shares.slice();
      current.running = false;
      redraw.current();
    } else {
      current.startedAt = performance.now();
      current.running = true;
      frameLoop.requestFrame();
    }
  }, [frameLoop, reducedMotion, shares]);

  useEffect(() => {
    hoveredRef.current = hovered;
    if (reducedMotion) redraw.current();
    else frameLoop.requestFrame();
  }, [frameLoop, hovered, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const style = getComputedStyle(canvas);
    const colorTokens = colorsKey ? colorsKey.split("\0") : [];
    const palette = colorTokens.map((color) => resolveColor(style, color));

    let scale = 1;
    const layout = () => {
      const size = host.clientWidth;
      if (!size) return;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(size * dpr);
      canvas.height = Math.ceil(size * dpr);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      scale = (size / LOGICAL) * dpr;
    };

    let drift = 0;

    const advanceMorph = (now: number) => {
      const current = morph.current;
      if (!current.running) return;
      const t = clamp01((now - current.startedAt) / MORPH_MS);
      const eased = 1 - Math.pow(2, -10 * t);
      current.displayed = current.target.map((v, i) => {
        const start = current.from[i] ?? 0;
        return start + (v - start) * eased;
      });
      if (t >= 1) {
        current.displayed = current.target.slice();
        current.running = false;
      }
    };

    const drawSlice = (color: string, arc: Arc, isHovered: boolean, anyHovered: boolean) => {
      if (arc.a1 - arc.a0 <= 0.004) return;
      ctx.save();

      if (isHovered) {
        const mid = (arc.a0 + arc.a1) / 2;
        ctx.translate(Math.cos(mid) * EXPLODE, Math.sin(mid) * EXPLODE);
        ctx.shadowColor = withAlpha(color, 0.55);
        ctx.shadowBlur = 5;
      }

      traceSlice(ctx, arc);
      ctx.clip();

      ctx.globalAlpha = !anyHovered ? BASE_ALPHA : isHovered ? 1 : DIM * BASE_ALPHA;
      ctx.fillStyle = color;

      const grow = isHovered ? 0.46 : 0.34;
      const lo = arc.a0 - 0.06;
      const hi = arc.a1 + 0.06;
      ctx.beginPath();
      for (const tile of TILES) {
        let angle = tile.angle;
        while (angle < lo) angle += TAU;
        while (angle >= lo + TAU) angle -= TAU;
        if (angle > hi) continue;

        const wave = tileWave(tile.x, tile.y, drift);
        const size =
          CELL * (grow + 0.36 * tile.fullness + 0.26 * wave) * (0.78 + 0.42 * tile.jitter);
        ctx.rect(tile.x - size / 2, tile.y - size / 2, size, size);
      }
      ctx.fill();
      ctx.restore();
    };

    const draw = (now: number) => {
      drift = now * DRIFT_RATE;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, LOGICAL, LOGICAL);
      const current = arcsFrom(morph.current.displayed);
      arcs.current = current;

      const hover = hoveredRef.current;
      const anyHovered = hover !== null;

      current.forEach((arc, i) => {
        if (i !== hover) drawSlice(palette[i] ?? palette[0] ?? "", arc, false, anyHovered);
      });
      // Hovered last: its shadow must land on top of its neighbours.
      const hot = hover === null ? undefined : current[hover];
      if (hot) drawSlice(palette[hover!] ?? "", hot, true, true);
    };

    const renderStatic = () => {
      layout();
      draw(performance.now());
    };
    redraw.current = renderStatic;

    frameLoop.setFrameHandler((now) => {
      advanceMorph(now);
      draw(now);
      if (morph.current.running) return "active";
      return hoveredRef.current === null ? "stop" : "idle";
    });

    layout();
    const onResize = () => {
      layout();
      if (reducedMotion) draw(performance.now());
      else frameLoop.requestFrame();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    if (reducedMotion) draw(performance.now());

    return () => {
      frameLoop.setFrameHandler(null);
      observer.disconnect();
    };
  }, [canvasRef, colorsKey, frameLoop, reducedMotion, theme]);

  const hitTest = (clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const dx = ((clientX - rect.left) / rect.width) * LOGICAL - CX;
    const dy = ((clientY - rect.top) / rect.height) * LOGICAL - CY;
    const distance = Math.hypot(dx, dy);
    if (distance < R_INNER || distance > R_OUTER) return null;

    const raw = Math.atan2(dy, dx);
    for (let i = 0; i < arcs.current.length; i++) {
      const { a0, a1 } = arcs.current[i]!;
      let angle = raw;
      while (angle < a0) angle += TAU;
      while (angle >= a0 + TAU) angle -= TAU;
      if (angle <= a1) return i;
    }
    return null;
  };

  return { hitTest };
}
