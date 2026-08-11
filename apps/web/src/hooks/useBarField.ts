/**
 * Paints a (stacked) bar chart onto a canvas as a field of drifting tiles and
 * hit-tests pointer positions back to a column/band pair.
 *
 * Bar heights are kept in pixels rather than in data units: a data change eases
 * out of whatever is currently on screen, so a change mid-animation continues
 * from where the bar visually is instead of snapping back to zero.
 */
import { useEffect, useRef, type RefObject } from "react";

import { clamp01, hashUnit, resolveColor, smoothstep, tileWave } from "../lib/chart-shading";

const MAX_DPR = 2;
const CORNER = 5;
const CAP_TOP = 8;
const CAP_BOTTOM = 7;

const GROW_MS = 620;
const COLUMN_STAGGER = 0.05;
// Leave every column at least 20% of the timeline for its own growth.
const MAX_STAGGER_SPAN = 0.8;
/** A crest crosses the field in ~8s: legible drift without reading as busy. */
const DRIFT_STEP = 0.03;

const DIM_OTHER_COLUMN = 0.3;
const DIM_SIBLING_BAND = 0.48;

export interface BarHover {
  column: number;
  band: number | null;
}

export interface BarFieldLayout {
  /** Share of a column's width taken by its bar. */
  barRatio: number;
  barMax: number;
  bandGap: number;
  /** Pixel floor for a non-zero band, so a thin slice stays visible. */
  minBand: number;
}

export const DEFAULT_BAR_LAYOUT: BarFieldLayout = {
  barRatio: 0.62,
  barMax: 76,
  bandGap: 4,
  minBand: 6,
};

export function columnProgress(index: number, count: number, progress: number) {
  const columnIntervals = Math.max(1, count - 1);
  const stagger = Math.min(COLUMN_STAGGER, MAX_STAGGER_SPAN / columnIntervals);
  const span = 1 - (count - 1) * stagger;
  const local = clamp01((progress - index * stagger) / span);
  return 1 - Math.pow(1 - local, 3);
}

interface Options {
  /** `[column][band]`; a plain bar chart is one band per column. */
  values: number[][];
  axisMax: number;
  colors: readonly string[];
  highlight: string;
  hovered: BarHover | null;
  layout: BarFieldLayout;
  reducedMotion: boolean;
}

export function useBarField(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  { values, axisMax, colors, highlight, hovered, layout, reducedMotion }: Options,
) {
  const state = useRef({ values, axisMax, colors, highlight, hovered, layout });
  state.current = { values, axisMax, colors, highlight, hovered, layout };

  const drawn = useRef(new Map<string, number>());
  const from = useRef(new Map<string, number>());
  const grow = useRef({ startedAt: 0, running: false });
  const size = useRef({ w: 0, h: 0 });
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    from.current = new Map(drawn.current);
    if (reducedMotion) {
      grow.current.running = false;
      redraw.current();
    } else {
      grow.current = { startedAt: performance.now(), running: true };
    }
  }, [values, axisMax, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) redraw.current();
  }, [hovered, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const layoutCanvas = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      size.current = { w, h };
    };

    let drift = 0;

    const animatedColumnProgress = (index: number, count: number, now: number) => {
      if (!grow.current.running) return 1;
      const progress = clamp01((now - grow.current.startedAt) / GROW_MS);
      if (progress >= 1) grow.current.running = false;
      return columnProgress(index, count, progress);
    };

    const drawBand = (
      x: number,
      y: number,
      w: number,
      h: number,
      color: string,
      glow: string,
      alpha: number,
      hot: boolean,
      isTop: boolean,
      isBottom: boolean,
      cell: number,
    ) => {
      const radii = [
        isTop ? CAP_TOP : CORNER,
        isTop ? CAP_TOP : CORNER,
        isBottom ? CAP_BOTTOM : CORNER,
        isBottom ? CAP_BOTTOM : CORNER,
      ];
      const trace = () => {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radii);
      };

      ctx.save();
      trace();
      ctx.clip();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;

      const base = hot ? 0.5 : 0.36;
      // A band thinner than a tile still gets one row, centred in it: the small
      // classes of a lopsided stack would otherwise fall through the loop and
      // the bar would read as a single band.
      const firstRow = Math.min(cell, h) / 2;
      ctx.beginPath();
      for (let tx = x + cell / 2; tx < x + w; tx += cell) {
        for (let ty = y + firstRow; ty < y + h; ty += cell) {
          const topness = smoothstep(1 - (ty - y) / h);
          const wave = tileWave(tx, ty, drift);
          const s = cell * (base + 0.34 * topness + 0.26 * wave) * (0.8 + 0.4 * hashUnit(tx, ty));
          ctx.rect(tx - s / 2, ty - s / 2, s, s);
        }
      }
      ctx.fill();
      ctx.restore();

      // A band keeps its own colour when hot — it encodes a series here — so the
      // highlight is carried by denser tiles plus an outline in the accent.
      if (hot) {
        ctx.save();
        trace();
        ctx.strokeStyle = glow;
        ctx.lineWidth = 1.75;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.restore();
      }
    };

    const draw = (now: number) => {
      const { w, h } = size.current;
      if (!w || !h) return;
      const current = state.current;
      ctx.clearRect(0, 0, w, h);
      if (!current.values.length || current.axisMax <= 0) return;

      const style = getComputedStyle(canvas);
      const palette = current.colors.map((color) => resolveColor(style, color));
      const highlightColor = resolveColor(style, current.highlight);

      const { barRatio, barMax, bandGap, minBand } = current.layout;
      const count = current.values.length;
      const columnW = w / count;
      const barW = Math.min(columnW * barRatio, barMax);
      const cell = Math.max(3, Math.round(w / 200));
      const scale = h / current.axisMax;
      const hover = current.hovered;

      current.values.forEach((bands, column) => {
        const progress = animatedColumnProgress(column, count, now);
        const x = column * columnW + (columnW - barW) / 2;
        let bottom = h;

        bands.forEach((value, band) => {
          const key = `${column}:${band}`;
          const target = value > 0 ? Math.max(minBand, value * scale) : 0;
          const start = from.current.get(key) ?? 0;
          const height = start + (target - start) * progress;
          drawn.current.set(key, height);

          const hot = hover?.column === column && hover.band === band;
          const alpha =
            hover == null
              ? 1
              : hover.column !== column
                ? DIM_OTHER_COLUMN
                : hover.band === null || hot
                  ? 1
                  : DIM_SIBLING_BAND;

          if (height > 0) {
            drawBand(
              x,
              bottom - height,
              barW,
              height,
              palette[band] ?? palette[0] ?? highlightColor,
              highlightColor,
              alpha,
              hot,
              band === bands.length - 1,
              band === 0,
              cell,
            );
          }
          bottom -= height + bandGap;
        });
      });
    };

    const renderStatic = () => {
      layoutCanvas();
      draw(performance.now());
    };
    redraw.current = renderStatic;

    let frame = 0;
    const loop = (now: number) => {
      drift += DRIFT_STEP;
      draw(now);
      frame = requestAnimationFrame(loop);
    };

    layoutCanvas();
    const observer = new ResizeObserver(renderStatic);
    observer.observe(host);

    if (reducedMotion) draw(performance.now());
    else frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [canvasRef, reducedMotion]);

  const hitTest = (clientX: number, clientY: number): BarHover | null => {
    const canvas = canvasRef.current;
    const { w, h } = size.current;
    if (!canvas || !w) return null;
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * w;
    const y = ((clientY - rect.top) / rect.height) * h;

    const { values, layout: bars } = state.current;
    const count = values.length;
    const columnW = w / count;
    const column = Math.floor(x / columnW);
    if (column < 0 || column >= count) return null;

    const barW = Math.min(columnW * bars.barRatio, bars.barMax);
    const x0 = column * columnW + (columnW - barW) / 2;
    if (x < x0 || x > x0 + barW) return { column, band: null };

    let bottom = h;
    for (let band = 0; band < values[column]!.length; band++) {
      const height = drawn.current.get(`${column}:${band}`) ?? 0;
      if (height > 0 && y <= bottom && y >= bottom - height) return { column, band };
      bottom -= height + bars.bandGap;
    }
    return { column, band: null };
  };

  return { hitTest };
}
