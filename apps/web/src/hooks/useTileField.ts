/**
 * Paints an area plot as a mosaic: every cell of a grid is drawn, and the ones
 * under the curve light up along a colour ramp. The cursor drags a soft glow
 * across the field, which is the whole reason the area is tiles and not a path.
 *
 * The curve lives outside React so a data change reflows the field in place
 * instead of remounting the canvas.
 */
import { useContext, useEffect, useRef, type RefObject } from "react";

import { curveAt, resampleCurve, SAMPLES, topFraction } from "../lib/curve";
import { useCanvasFrameLoop } from "./useCanvasFrameLoop";
import { ResolvedThemeContext } from "./useTheme";

const MAX_DPR = 2;
const RESHAPE_MS = 460;
const CELL_DIVISOR = 180;
const LEVELS = 32;

const SPARK_RATIO = 0.06;
const GLOW_RISE = 0.22;
const GLOW_DECAY = 0.05;
const POINTER_SMOOTHING = 0.28;
const RADIUS_MIN = 0.24;
const RADIUS_MAX = 0.5;

const OKLCH = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/;

/** Deterministic per-cell noise, so sparks stay put across re-layouts. */
function hashUnit(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The ramp is interpolated in OKLCH, where a straight line between two stops
 * stays perceptually even — the whole point of a ramp read as intensity.
 */
function buildRamp(wash: string, ink: string): string[] {
  const from = OKLCH.exec(wash);
  const to = OKLCH.exec(ink);
  if (!from || !to) return Array.from({ length: LEVELS + 1 }, () => ink);

  const [l0, c0, h0] = [Number(from[1]), Number(from[2]), Number(from[3])];
  const [l1, c1, h1] = [Number(to[1]), Number(to[2]), Number(to[3])];
  return Array.from({ length: LEVELS + 1 }, (_, i) => {
    const t = i / LEVELS;
    const l = l0 + (l1 - l0) * t;
    const c = c0 + (c1 - c0) * t;
    const h = h0 + (h1 - h0) * t;
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
  });
}

interface Grid {
  cell: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  left: number;
  top: number;
  /** Drawing unit: tile geometry snaps to this so edges never land mid-pixel. */
  step: number;
  glow: Float32Array;
  spark: Uint8Array;
}

interface Options {
  values: number[];
  max: number;
  reducedMotion: boolean;
}

export function useTileField(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  { values, max, reducedMotion }: Options,
) {
  const theme = useContext(ResolvedThemeContext);
  const frameLoop = useCanvasFrameLoop(canvasRef, reducedMotion);

  const curve = useRef({
    from: resampleCurve(values),
    to: resampleCurve(values),
    current: resampleCurve(values),
    fromMax: max,
    toMax: max,
    currentMax: max,
    startedAt: 0,
    duration: 0,
  });

  const grid = useRef<Grid | null>(null);
  const redraw = useRef<() => void>(() => {});
  const pointer = useRef({
    x: -1e4,
    y: -1e4,
    smoothX: -1e4,
    smoothY: -1e4,
    speed: 0,
    inside: false,
  });

  useEffect(() => {
    const state = curve.current;
    state.from.set(state.current);
    state.fromMax = state.currentMax;
    resampleCurve(values, state.to);
    state.toMax = max;
    state.startedAt = performance.now();
    state.duration = reducedMotion ? 0 : RESHAPE_MS;
    if (reducedMotion) redraw.current();
    else frameLoop.requestFrame();
  }, [frameLoop, max, reducedMotion, values]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;
    const pointerState = pointer.current;

    const style = getComputedStyle(canvas);
    const rest = style.getPropertyValue("--tile-rest").trim();
    const wash = style.getPropertyValue("--tile-wash").trim();
    const ink = style.getPropertyValue("--tile-ink").trim();
    const ramp = buildRamp(wash, ink);

    const layout = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      const bounds = host.getBoundingClientRect();
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      const cell = Math.max(3, Math.round(width / CELL_DIVISOR));
      const cols = Math.ceil(width / cell);
      const rows = Math.ceil(height / cell);
      const count = cols * rows;
      const spark = new Uint8Array(count);
      for (let i = 0; i < count; i++) spark[i] = hashUnit(i) < SPARK_RATIO ? 1 : 0;
      grid.current = {
        cell,
        cols,
        rows,
        width,
        height,
        left: bounds.left,
        top: bounds.top,
        step: 1 / dpr,
        glow: new Float32Array(count),
        spark,
      };
    };

    const advanceCurve = (now: number) => {
      const state = curve.current;
      const t = state.duration > 0 ? Math.min(1, (now - state.startedAt) / state.duration) : 1;
      for (let s = 0; s < SAMPLES; s++) {
        state.current[s] = state.from[s]! + (state.to[s]! - state.from[s]!) * t;
      }
      state.currentMax = state.fromMax + (state.toMax - state.fromMax) * t;
      if (t >= 1) state.duration = 0;
      return t < 1;
    };

    const advancePointer = (frameScale: number) => {
      const p = pointer.current;
      const previousX = p.smoothX;
      const previousY = p.smoothY;
      const smoothing = 1 - Math.pow(1 - POINTER_SMOOTHING, frameScale);
      p.smoothX += (p.x - previousX) * smoothing;
      p.smoothY += (p.y - previousY) * smoothing;
      p.speed = Math.hypot(p.smoothX - previousX, p.smoothY - previousY);
    };

    const draw = (now: number, frameScale = 1) => {
      const g = grid.current;
      if (!g) return false;
      const state = curve.current;
      const { cell, cols, rows, width, height, step, glow, spark } = g;
      // fillRect antialiases regardless of imageSmoothingEnabled, so a tile whose
      // edge lands mid-pixel shimmers as it resizes. Quantise to device pixels.
      const snap = (value: number) => Math.round(value / step) * step;
      const restSize = Math.max(step, snap(cell * 0.34));
      const restOffset = snap((cell - restSize) / 2);

      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = rest;
      for (let col = 0; col < cols; col++) {
        const x = col * cell + restOffset;
        for (let row = 0; row < rows; row++) {
          ctx.fillRect(x, row * cell + restOffset, restSize, restSize);
        }
      }

      const p = pointer.current;
      const radius = height * (RADIUS_MIN + Math.min(1, p.speed / 25) * (RADIUS_MAX - RADIUS_MIN));
      const glowActive = !reducedMotion && p.inside;
      const glowRise = 1 - Math.pow(1 - GLOW_RISE, frameScale);
      const glowDecay = 1 - Math.pow(1 - GLOW_DECAY, frameScale);
      const shimmerPhase = now * 0.0018;
      let level = -1;
      let hasGlow = false;

      for (let col = 0; col < cols; col++) {
        const fx = cols > 1 ? (col + 0.5) / cols : 0.5;
        const top = topFraction(curveAt(state.current, fx), state.currentMax);
        const span = Math.max(1e-3, 1 - top);
        const x = col * cell;
        const cx = x + cell / 2;

        for (let row = 0; row < rows; row++) {
          const i = col * rows + row;
          const y = row * cell;
          const fy = (y + cell / 2) / height;

          let shape = 0;
          if (fy >= top) shape = 1 - 0.55 * ((fy - top) / span);

          let lit = glow[i]!;
          if (glowActive) {
            const distance = Math.hypot(cx - p.smoothX, y + cell / 2 - p.smoothY);
            const target = distance < radius ? 1 - distance / radius : 0;
            lit += (target - lit) * (target > lit ? glowRise : glowDecay);
            glow[i] = lit;
          } else if (lit > 0) {
            lit *= 1 - glowDecay;
            glow[i] = lit < 0.002 ? 0 : lit;
          }
          if (glow[i]! > 0) hasGlow = true;

          // Size carries the low-frequency structure only. Shimmer and sparks are
          // high-frequency and drive colour alone — quantised size cannot express
          // them without flickering between steps, which reads as crawling.
          const solid = Math.min(1, shape + lit * 0.5);
          if (solid <= 0.02) continue;

          let tint = solid;
          if (!reducedMotion) {
            tint *= 1 + 0.07 * Math.sin(fy * Math.PI * 3 - shimmerPhase);
            if (spark[i] && lit > 0.02) tint *= 1 + 0.25 * lit * Math.sin(now * 0.012 + i);
            tint = Math.min(1, tint);
          }

          const size = Math.max(step, snap(cell * (0.28 + 0.42 * solid)));
          const offset = snap((cell - size) / 2);

          const next = Math.round(tint * LEVELS);
          if (next !== level) {
            level = next;
            ctx.fillStyle = ramp[level] ?? ramp[LEVELS] ?? rest;
          }
          ctx.fillRect(x + offset, y + offset, size, size);
        }
      }
      return hasGlow;
    };

    const renderStatic = () => {
      layout();
      advanceCurve(performance.now());
      draw(performance.now());
    };
    redraw.current = renderStatic;

    const onPointerMove = (event: PointerEvent) => {
      const g = grid.current;
      if (!g) return;
      const p = pointer.current;
      if (!p.inside) {
        const bounds = host.getBoundingClientRect();
        g.left = bounds.left;
        g.top = bounds.top;
      }
      p.x = event.clientX - g.left;
      p.y = event.clientY - g.top;
      if (!p.inside) {
        p.smoothX = p.x;
        p.smoothY = p.y;
      }
      p.inside = true;
      frameLoop.requestFrame();
    };
    const onPointerOut = () => {
      pointer.current.inside = false;
      frameLoop.requestFrame();
    };

    let lastFrameTime = 0;
    frameLoop.setFrameHandler((now) => {
      const frameScale = lastFrameTime === 0 ? 1 : Math.min(3, (now - lastFrameTime) / (1000 / 60));
      lastFrameTime = now;
      const curveActive = advanceCurve(now);
      advancePointer(frameScale);
      const glowActive = draw(now, frameScale);
      if (curveActive) return "active";
      if (pointer.current.inside || glowActive) return "idle";
      lastFrameTime = 0;
      return "stop";
    });

    layout();
    const onResize = () => {
      layout();
      if (reducedMotion) {
        advanceCurve(performance.now());
        draw(performance.now());
      } else {
        frameLoop.requestFrame();
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    if (reducedMotion) {
      renderStatic();
    } else {
      host.addEventListener("pointermove", onPointerMove, { passive: true });
      host.addEventListener("pointerleave", onPointerOut);
    }

    return () => {
      frameLoop.setFrameHandler(null);
      observer.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerOut);
      pointerState.inside = false;
    };
  }, [canvasRef, frameLoop, reducedMotion, theme]);
}
