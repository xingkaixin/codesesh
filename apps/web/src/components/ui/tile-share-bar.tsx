import { useContext, useEffect, useRef } from "react";
import { useCanvasFrameLoop } from "../../hooks/useCanvasFrameLoop";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { ResolvedThemeContext } from "../../hooks/useTheme";
import { hashUnit, resolveColor, smoothstep, tileWave } from "../../lib/chart-shading";
import { ChartKeyboardList } from "./chart-keyboard-list";

const HEIGHT = 32;
const CELL = 4;

export function TileShareBar({
  shares,
  colors,
  hovered,
  onHover,
  ariaLabel,
  itemLabels,
}: {
  shares: readonly number[];
  colors: readonly string[];
  hovered: number | null;
  onHover: (index: number | null) => void;
  ariaLabel: string;
  itemLabels: readonly string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const theme = useContext(ResolvedThemeContext);
  const frameLoop = useCanvasFrameLoop(canvasRef, reducedMotion);
  const hoveredRef = useRef(hovered);
  const redraw = useRef(() => {});
  const sharesKey = shares.join(",");
  const colorsKey = colors.join("\0");

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
    const palette = colorsKey.split("\0").map((color) => resolveColor(style, color));
    const fractions = sharesKey.split(",").map(Number);
    let width = 0;

    const layout = () => {
      width = host.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = HEIGHT * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, HEIGHT);
      let cursor = 0;
      fractions.forEach((share, index) => {
        const segmentWidth = share * width;
        const gap = Math.min(1, segmentWidth / 6);
        const x = cursor + gap;
        const w = segmentWidth - gap * 2;
        cursor += segmentWidth;
        if (w <= 0) return;
        const hot = hoveredRef.current === index;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, 0, w, HEIGHT, Math.min(4, w / 2));
        ctx.clip();
        ctx.fillStyle = palette[index] ?? "";
        ctx.globalAlpha = hoveredRef.current === null ? 0.72 : hot ? 1 : 0.3;
        ctx.beginPath();
        for (let tx = x + Math.min(CELL, w) / 2; tx < x + w; tx += CELL) {
          for (let ty = CELL / 2; ty < HEIGHT; ty += CELL) {
            const fullness = smoothstep(1 - ty / HEIGHT);
            const wave = tileWave(tx, ty, now * 0.0018);
            const size =
              CELL *
              ((hot ? 0.46 : 0.34) + 0.36 * fullness + 0.26 * wave) *
              (0.78 + 0.42 * hashUnit(tx, ty));
            ctx.rect(tx - size / 2, ty - size / 2, size, size);
          }
        }
        ctx.fill();
        ctx.restore();
      });
    };

    redraw.current = () => draw(performance.now());
    const resize = () => {
      layout();
      if (reducedMotion) redraw.current();
      else frameLoop.requestFrame();
    };
    frameLoop.setFrameHandler((now) => {
      draw(now);
      return hoveredRef.current === null ? "stop" : "idle";
    });
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    return () => {
      observer.disconnect();
      frameLoop.setFrameHandler(null);
    };
  }, [colorsKey, frameLoop, reducedMotion, sharesKey, theme]);

  return (
    <div
      className="chart-hatch relative rounded-sm"
      style={{ height: HEIGHT }}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - rect.left) / rect.width;
        let boundary = 0;
        const index = shares.findIndex((share) => {
          boundary += share;
          return position < boundary;
        });
        onHover(index < 0 ? null : index);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") onHover(null);
      }}
    >
      <canvas ref={canvasRef} aria-hidden className="block size-full" />
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
