import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { SessionTimelineEntry, SessionTimelineEntryKind } from "./timeline";

export interface MinimapWindow {
  start: number;
  size: number;
}

interface SessionMessageTimelineMinimapProps {
  entries: SessionTimelineEntry[];
  viewportRef: RefObject<HTMLDivElement | null>;
  visibleWindow: MinimapWindow;
}

const KIND_TOKEN: Record<SessionTimelineEntryKind, string> = {
  user: "--timeline-user",
  agent: "--timeline-agent",
  "tool-read": "--timeline-tool-read",
  "tool-write": "--timeline-tool-write",
  "tool-execute": "--timeline-tool-execute",
};

export function SessionMessageTimelineMinimap({
  entries,
  viewportRef,
  visibleWindow,
}: SessionMessageTimelineMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ pointerId: number; grabOffset: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const context = canvas.getContext("2d");
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!context || !width || !height || entries.length === 0) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);
      const styles = window.getComputedStyle(canvas);
      const colors = Object.fromEntries(
        Object.entries(KIND_TOKEN).map(([kind, token]) => [
          kind,
          styles.getPropertyValue(token).trim() || styles.color,
        ]),
      ) as Record<SessionTimelineEntryKind, string>;
      entries.forEach((entry, index) => {
        const x0 = (index / entries.length) * width;
        const x1 = ((index + 1) / entries.length) * width;
        context.fillStyle = colors[entry.kind];
        context.fillRect(x0, 0, Math.max(x1 - x0, 0.5), height);
      });
    };

    draw();
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    if (typeof ResizeObserver === "undefined") return () => themeObserver.disconnect();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [entries]);

  const scrollToRatio = useCallback(
    (ratio: number, grabOffset: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = (ratio - grabOffset) * viewport.scrollWidth;
    },
    [viewportRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const step = Math.max(40, viewport.clientWidth * 0.1);
      const page = Math.max(120, viewport.clientWidth * 0.75);
      let next: number | null = null;

      if (event.key === "ArrowLeft") next = viewport.scrollLeft - step;
      if (event.key === "ArrowRight") next = viewport.scrollLeft + step;
      if (event.key === "PageUp") next = viewport.scrollLeft - page;
      if (event.key === "PageDown") next = viewport.scrollLeft + page;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = maxScrollLeft;
      if (next == null) return;

      event.preventDefault();
      viewport.scrollLeft = Math.min(maxScrollLeft, Math.max(0, next));
    },
    [viewportRef],
  );

  return (
    <div
      data-testid="session-timeline-minimap"
      role="scrollbar"
      aria-controls="session-timeline-viewport"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((visibleWindow.start / (1 - visibleWindow.size)) * 100)}
      aria-label="Timeline scroll position"
      tabIndex={0}
      className="session-timeline-minimap relative mt-2 h-2.5 cursor-pointer touch-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = (event.clientX - rect.left) / rect.width;
        const withinWindow =
          ratio >= visibleWindow.start && ratio <= visibleWindow.start + visibleWindow.size;
        const grabOffset = withinWindow ? ratio - visibleWindow.start : visibleWindow.size / 2;
        dragRef.current = { pointerId: event.pointerId, grabOffset };
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollToRatio(ratio, grabOffset);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        scrollToRatio((event.clientX - rect.left) / rect.width, drag.grabOffset);
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[2px]">
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
        <div
          data-testid="session-timeline-minimap-window"
          className="session-timeline-minimap-window absolute inset-y-0"
          style={{
            left: `${visibleWindow.start * 100}%`,
            width: `${visibleWindow.size * 100}%`,
          }}
        />
      </div>
    </div>
  );
}
