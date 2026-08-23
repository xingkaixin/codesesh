import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getInitialTimelineRenderRange,
  getTimelineRenderRange,
  scrollTimelineIndexIntoView,
  VIRTUALIZED_TIMELINE_THRESHOLD,
} from "./session-message-timeline-layout";
import type { MinimapWindow } from "./session-message-timeline-minimap";

const TIMELINE_SCROLL_EDGE_TOLERANCE = 1;

interface TimelineViewportOptions {
  activeIndex: number;
  entryCount: number;
  gapWidth: number;
}

export function useSessionMessageTimelineViewport({
  activeIndex,
  entryCount,
  gapWidth,
}: TimelineViewportOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [scrollAvailability, setScrollAvailability] = useState({ left: false, right: false });
  const [minimapWindow, setMinimapWindow] = useState<MinimapWindow | null>(null);
  const [renderRange, setRenderRange] = useState(() => getInitialTimelineRenderRange(entryCount));
  const virtualized = entryCount > VIRTUALIZED_TIMELINE_THRESHOLD;
  const renderStart = virtualized ? Math.min(renderRange.start, entryCount) : 0;
  const renderEnd = virtualized
    ? Math.max(renderStart, Math.min(renderRange.end, entryCount))
    : entryCount;

  const update = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const nextRenderRange = getTimelineRenderRange(
      entryCount,
      viewport.scrollLeft,
      viewport.clientWidth,
      viewport.scrollWidth,
    );
    setRenderRange((current) =>
      current.start === nextRenderRange.start && current.end === nextRenderRange.end
        ? current
        : nextRenderRange,
    );
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const nextAvailability = {
      left: viewport.scrollLeft > TIMELINE_SCROLL_EDGE_TOLERANCE,
      right: viewport.scrollLeft < maxScrollLeft - TIMELINE_SCROLL_EDGE_TOLERANCE,
    };
    setScrollAvailability((current) =>
      current.left === nextAvailability.left && current.right === nextAvailability.right
        ? current
        : nextAvailability,
    );
    if (maxScrollLeft <= 0) {
      setMinimapWindow(null);
      return;
    }
    const nextWindow = {
      start: viewport.scrollLeft / viewport.scrollWidth,
      size: viewport.clientWidth / viewport.scrollWidth,
    };
    setMinimapWindow((current) =>
      current?.start === nextWindow.start && current.size === nextWindow.size
        ? current
        : nextWindow,
    );
  }, [entryCount]);

  useLayoutEffect(() => {
    update();
    const viewport = scrollRef.current;
    const track = trackRef.current;
    if (!viewport || !track || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [entryCount, update]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    scrollTimelineIndexIntoView(viewport, track, activeIndex, entryCount, gapWidth);
    update();
  }, [activeIndex, entryCount, gapWidth, update]);

  useLayoutEffect(() => {
    const pendingIndex = pendingFocusIndexRef.current;
    if (pendingIndex == null) return;
    const segment = trackRef.current?.querySelector<HTMLButtonElement>(
      `[data-timeline-index="${pendingIndex}"]`,
    );
    if (!segment) return;
    pendingFocusIndexRef.current = null;
    segment.focus();
  }, [renderEnd, renderStart]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollLeft += direction * Math.max(120, viewport.clientWidth * 0.75);
  }, []);

  const focusIndex = useCallback(
    (index: number) => {
      const viewport = scrollRef.current;
      const track = trackRef.current;
      if (!viewport || !track) return;
      const segment = track.querySelector<HTMLButtonElement>(`[data-timeline-index="${index}"]`);
      if (segment) {
        segment.focus();
        return;
      }

      pendingFocusIndexRef.current = index;
      scrollTimelineIndexIntoView(viewport, track, index, entryCount, gapWidth);
      update();
    },
    [entryCount, gapWidth, update],
  );

  return {
    scrollRef,
    trackRef,
    virtualized,
    renderStart,
    renderEnd,
    scrollAvailability,
    minimapWindow,
    update,
    scrollByPage,
    focusIndex,
  };
}
