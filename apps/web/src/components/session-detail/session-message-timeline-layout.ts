import type { CSSProperties } from "react";

export const TIMELINE_SEGMENT_MIN_WIDTH = 10;
export const VIRTUALIZED_TIMELINE_THRESHOLD = 80;

const VIRTUALIZED_TIMELINE_OVERSCAN = 6;

export interface TimelineRenderRange {
  start: number;
  end: number;
}

export function getInitialTimelineRenderRange(entryCount: number): TimelineRenderRange {
  return {
    start: 0,
    end: Math.min(entryCount, VIRTUALIZED_TIMELINE_THRESHOLD),
  };
}

export function getTimelineRenderRange(
  entryCount: number,
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): TimelineRenderRange {
  if (entryCount <= VIRTUALIZED_TIMELINE_THRESHOLD) {
    return { start: 0, end: entryCount };
  }
  if (clientWidth <= 0 || scrollWidth <= 0) {
    return getInitialTimelineRenderRange(entryCount);
  }
  if (clientWidth >= scrollWidth) {
    return { start: 0, end: entryCount };
  }

  const visibleStart = Math.floor((Math.max(0, scrollLeft) / scrollWidth) * entryCount);
  const visibleEnd = Math.ceil(
    (Math.min(scrollWidth, scrollLeft + clientWidth) / scrollWidth) * entryCount,
  );
  return {
    start: Math.max(0, visibleStart - VIRTUALIZED_TIMELINE_OVERSCAN),
    end: Math.min(entryCount, visibleEnd + VIRTUALIZED_TIMELINE_OVERSCAN),
  };
}

export function getVirtualizedSegmentStyle(
  index: number,
  entryCount: number,
  gapWidth: number,
): CSSProperties {
  const segmentWidth = 100 / entryCount;
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `calc(${index * segmentWidth}% + ${(index * gapWidth) / entryCount}px)`,
    width: `calc(${segmentWidth}% - ${((entryCount - 1) * gapWidth) / entryCount}px)`,
  };
}

export function getTrackLayout(entryCount: number) {
  const gap =
    entryCount > 80
      ? { className: "gap-px", width: 1 }
      : entryCount > 40
        ? { className: "gap-0.5", width: 2 }
        : { className: "gap-1", width: 4 };
  return {
    gapClassName: gap.className,
    gapWidth: gap.width,
    minWidth: entryCount * TIMELINE_SEGMENT_MIN_WIDTH + Math.max(0, entryCount - 1) * gap.width,
  };
}

export function scrollTimelineIndexIntoView(
  viewport: HTMLElement,
  track: HTMLElement,
  index: number,
  entryCount: number,
  gapWidth: number,
) {
  if (entryCount === 0 || viewport.clientWidth <= 0) return;
  const trackWidth = Math.max(
    viewport.scrollWidth,
    track.scrollWidth,
    track.getBoundingClientRect().width,
  );
  if (trackWidth <= 0) return;

  const segmentWidth = Math.max(
    0,
    (trackWidth - Math.max(0, entryCount - 1) * gapWidth) / entryCount,
  );
  const segmentStart = index * (segmentWidth + gapWidth);
  const segmentEnd = segmentStart + segmentWidth;
  const viewportStart = viewport.scrollLeft;
  const viewportEnd = viewportStart + viewport.clientWidth;

  if (segmentStart < viewportStart) {
    viewport.scrollLeft = segmentStart;
  } else if (segmentEnd > viewportEnd) {
    viewport.scrollLeft = segmentEnd - viewport.clientWidth;
  }
}
