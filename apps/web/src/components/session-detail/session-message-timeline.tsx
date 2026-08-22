import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "../ui/icons";
import {
  findTimelineIndexAtPointer,
  type SessionTimelineEntry,
  type SessionTimelineEntryKind,
} from "./timeline";
import { getActivationScrollBehavior, type SessionAnchorScrollBehavior } from "./scroll-behavior";
import type { TimelineAnchorRegistry } from "./timeline-anchor-registry";
import {
  getInitialTimelineRenderRange,
  getTimelineRenderRange,
  getTrackLayout,
  getVirtualizedSegmentStyle,
  scrollTimelineIndexIntoView,
  TIMELINE_SEGMENT_MIN_WIDTH,
  VIRTUALIZED_TIMELINE_THRESHOLD,
} from "./session-message-timeline-layout";
import {
  SessionMessageTimelineMinimap,
  type MinimapWindow,
} from "./session-message-timeline-minimap";
import { useActiveTimelineIndex } from "./use-active-timeline-index";

export { VIRTUALIZED_TIMELINE_THRESHOLD } from "./session-message-timeline-layout";

interface SessionMessageTimelineProps {
  entries: SessionTimelineEntry[];
  anchorRegistry: TimelineAnchorRegistry;
  onNavigate: (entry: SessionTimelineEntry, behavior: SessionAnchorScrollBehavior) => void;
}

interface TimelineTooltip {
  entryId: string;
  id: string;
  text: string;
  anchorX: number;
  top: number;
  source: "focus" | "pointer";
}

const TIMELINE_SCROLL_EDGE_TOLERANCE = 1;
const TIMELINE_TOOLTIP_VIEWPORT_PADDING = 8;

const KIND_CLASS: Record<SessionTimelineEntryKind, string> = {
  user: "bg-[var(--timeline-user)]",
  agent: "bg-[var(--timeline-agent)]",
  "tool-read": "bg-[var(--timeline-tool-read)]",
  "tool-write": "bg-[var(--timeline-tool-write)]",
  "tool-execute": "bg-[var(--timeline-tool-execute)]",
};

interface TimelineSegmentProps {
  entry: SessionTimelineEntry;
  index: number;
  isActive: boolean;
  isTooltipVisible: boolean;
  virtualized: boolean;
  entryCount: number;
  gapWidth: number;
  onShowTooltip: (
    entry: SessionTimelineEntry,
    trigger: HTMLElement,
    source: TimelineTooltip["source"],
  ) => void;
  onHideTooltip: (entryId: string) => void;
}

const TimelineSegment = memo(function TimelineSegment({
  entry,
  index,
  isActive,
  isTooltipVisible,
  virtualized,
  entryCount,
  gapWidth,
  onShowTooltip,
  onHideTooltip,
}: TimelineSegmentProps) {
  const tooltipId = `timeline-tooltip-${entry.id}`;
  return (
    <span
      className="session-timeline-item min-w-0"
      style={virtualized ? getVirtualizedSegmentStyle(index, entryCount, gapWidth) : undefined}
    >
      <button
        type="button"
        data-timeline-index={index}
        data-timeline-kind={entry.kind}
        aria-current={isActive ? "location" : undefined}
        aria-describedby={isTooltipVisible ? tooltipId : undefined}
        aria-label={`Go to ${entry.tooltip}`}
        className={`t-tt-trigger session-timeline-segment h-full w-full rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] ${KIND_CLASS[entry.kind]}`}
        onPointerEnter={(event) => onShowTooltip(entry, event.currentTarget, "pointer")}
        onPointerLeave={() => onHideTooltip(entry.id)}
        onFocus={(event) => onShowTooltip(entry, event.currentTarget, "focus")}
        onBlur={() => onHideTooltip(entry.id)}
      />
    </span>
  );
});

export function SessionMessageTimeline({
  entries,
  anchorRegistry,
  onNavigate,
}: SessionMessageTimelineProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipTriggerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, lastIndex: -1 });
  const suppressClickRef = useRef(false);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<TimelineTooltip | null>(null);
  const [scrollAvailability, setScrollAvailability] = useState({ left: false, right: false });
  const [minimapWindow, setMinimapWindow] = useState<MinimapWindow | null>(null);
  const [renderRange, setRenderRange] = useState(() =>
    getInitialTimelineRenderRange(entries.length),
  );
  const activeIndex = useActiveTimelineIndex({ rootRef, entries, anchorRegistry });
  const trackLayout = getTrackLayout(entries.length);
  const virtualized = entries.length > VIRTUALIZED_TIMELINE_THRESHOLD;
  const renderStart = virtualized ? Math.min(renderRange.start, entries.length) : 0;
  const renderEnd = virtualized
    ? Math.max(renderStart, Math.min(renderRange.end, entries.length))
    : entries.length;
  const renderedEntries = useMemo(
    () =>
      entries
        .slice(renderStart, renderEnd)
        .map((entry, offset) => ({ entry, index: renderStart + offset })),
    [entries, renderEnd, renderStart],
  );

  const updateScrollAvailability = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const nextRenderRange = getTimelineRenderRange(
      entries.length,
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
    const next = {
      left: viewport.scrollLeft > TIMELINE_SCROLL_EDGE_TOLERANCE,
      right: viewport.scrollLeft < maxScrollLeft - TIMELINE_SCROLL_EDGE_TOLERANCE,
    };
    setScrollAvailability((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
    if (maxScrollLeft <= 0) {
      setMinimapWindow(null);
      return;
    }
    const window = {
      start: viewport.scrollLeft / viewport.scrollWidth,
      size: viewport.clientWidth / viewport.scrollWidth,
    };
    setMinimapWindow((current) =>
      current?.start === window.start && current.size === window.size ? current : window,
    );
  }, [entries.length]);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element || !tooltip) return;
    const halfWidth = element.offsetWidth / 2;
    const left = Math.min(
      window.innerWidth - TIMELINE_TOOLTIP_VIEWPORT_PADDING - halfWidth,
      Math.max(TIMELINE_TOOLTIP_VIEWPORT_PADDING + halfWidth, tooltip.anchorX),
    );
    element.style.left = `${left}px`;
  }, [tooltip]);

  useLayoutEffect(() => {
    updateScrollAvailability();
    const viewport = scrollRef.current;
    const track = trackRef.current;
    if (!viewport || !track || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateScrollAvailability);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [entries.length, updateScrollAvailability]);

  useEffect(() => {
    const scrollViewport = scrollRef.current;
    const track = trackRef.current;
    if (!scrollViewport || !track) return;

    scrollTimelineIndexIntoView(
      scrollViewport,
      track,
      activeIndex,
      entries.length,
      trackLayout.gapWidth,
    );
    updateScrollAvailability();
  }, [activeIndex, entries.length, trackLayout.gapWidth, updateScrollAvailability]);

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

  const showTooltip = useCallback(
    (entry: SessionTimelineEntry, trigger: HTMLElement, source: TimelineTooltip["source"]) => {
      const rect = trigger.getBoundingClientRect();
      tooltipTriggerRef.current = trigger;
      setTooltip({
        entryId: entry.id,
        id: `timeline-tooltip-${entry.id}`,
        text: entry.tooltip,
        anchorX: rect.left + rect.width / 2,
        top: rect.bottom + 8,
        source,
      });
    },
    [],
  );

  const hideTooltip = useCallback((entryId: string) => {
    setTooltip((current) => {
      if (current?.entryId !== entryId) return current;
      tooltipTriggerRef.current = null;
      return null;
    });
  }, []);

  const handleTimelineScroll = useCallback(() => {
    updateScrollAvailability();
    setTooltip((current) => {
      const trigger = tooltipTriggerRef.current;
      if (
        !current ||
        current.source !== "focus" ||
        !trigger ||
        trigger !== document.activeElement
      ) {
        tooltipTriggerRef.current = null;
        return null;
      }

      const rect = trigger.getBoundingClientRect();
      return {
        ...current,
        anchorX: rect.left + rect.width / 2,
        top: rect.bottom + 8,
      };
    });
  }, [updateScrollAvailability]);

  const scrollTimeline = useCallback((direction: -1 | 1) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollLeft += direction * Math.max(120, viewport.clientWidth * 0.75);
  }, []);

  const navigateFromPointer = useCallback(
    (clientX: number, behavior: SessionAnchorScrollBehavior) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const index = findTimelineIndexAtPointer(clientX, rect.left, rect.width, entries.length);
      if (index == null || index === dragRef.current.lastIndex) return;
      const entry = entries[index];
      if (!entry) return;
      dragRef.current.lastIndex = index;
      onNavigate(entry, behavior);
    },
    [entries, onNavigate],
  );

  const focusTimelineIndex = useCallback(
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
      scrollTimelineIndexIntoView(viewport, track, index, entries.length, trackLayout.gapWidth);
      updateScrollAvailability();
    },
    [entries.length, trackLayout.gapWidth, updateScrollAvailability],
  );

  const handleTimelineKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const indexValue = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-timeline-index]",
      )?.dataset.timelineIndex;
      const index = indexValue == null ? null : Number(indexValue);
      if (index == null || !Number.isInteger(index)) return;

      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
      if (event.key === "ArrowRight") nextIndex = Math.min(entries.length - 1, index + 1);
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = entries.length - 1;
      if (nextIndex == null || nextIndex === index) return;

      event.preventDefault();
      focusTimelineIndex(nextIndex);
    },
    [entries.length, focusTimelineIndex],
  );

  return (
    <div className="sticky top-0 z-20 -mx-2 bg-[var(--console-bg)] px-2 py-3">
      <div
        ref={rootRef}
        className="session-message-timeline relative rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2.5 shadow-[var(--shadow-raised)]"
      >
        <div className="relative">
          <div
            ref={scrollRef}
            id="session-timeline-viewport"
            role="navigation"
            aria-label="Session message timeline"
            tabIndex={0}
            className="session-timeline-viewport overflow-x-auto overflow-y-hidden overscroll-x-contain py-1"
            onScroll={handleTimelineScroll}
          >
            <div
              ref={trackRef}
              data-testid="session-timeline-track"
              className={`${virtualized ? "relative" : `grid items-stretch ${trackLayout.gapClassName}`} h-5 w-full select-none`}
              style={
                virtualized
                  ? { minWidth: `${trackLayout.minWidth}px` }
                  : {
                      gridTemplateColumns: `repeat(${entries.length}, minmax(${TIMELINE_SEGMENT_MIN_WIDTH}px, 1fr))`,
                      minWidth: `${trackLayout.minWidth}px`,
                    }
              }
              onKeyDown={handleTimelineKeyDown}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragRef.current = {
                  active: true,
                  moved: false,
                  startX: event.clientX,
                  lastIndex: -1,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag.active) return;
                if (!drag.moved) {
                  if (Math.abs(event.clientX - drag.startX) < 3) return;
                  drag.moved = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }
                suppressClickRef.current = true;
                navigateFromPointer(event.clientX, "auto");
              }}
              onPointerUp={(event) => {
                dragRef.current.active = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                window.setTimeout(() => {
                  suppressClickRef.current = false;
                }, 0);
              }}
              onPointerCancel={() => {
                dragRef.current.active = false;
                suppressClickRef.current = false;
              }}
              onClick={(event) => {
                if (suppressClickRef.current) return;
                const behavior = getActivationScrollBehavior(event.detail);

                const indexValue = (event.target as HTMLElement).closest<HTMLButtonElement>(
                  "[data-timeline-index]",
                )?.dataset.timelineIndex;
                const index = indexValue == null ? null : Number(indexValue);
                const entry =
                  index == null || !Number.isInteger(index) ? undefined : entries[index];
                if (entry) {
                  onNavigate(entry, behavior);
                  return;
                }
                navigateFromPointer(event.clientX, behavior);
              }}
            >
              {renderedEntries.map(({ entry, index }) => (
                <TimelineSegment
                  key={entry.id}
                  entry={entry}
                  index={index}
                  isActive={index === activeIndex}
                  isTooltipVisible={tooltip?.entryId === entry.id}
                  virtualized={virtualized}
                  entryCount={entries.length}
                  gapWidth={trackLayout.gapWidth}
                  onShowTooltip={showTooltip}
                  onHideTooltip={hideTooltip}
                />
              ))}
            </div>
          </div>
          {scrollAvailability.left && (
            <button
              type="button"
              aria-label="Scroll timeline left"
              className="absolute inset-y-0 left-0 z-10 flex w-8 items-center justify-start bg-[linear-gradient(to_right,var(--console-surface)_55%,transparent)] pl-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand)]"
              onClick={() => scrollTimeline(-1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
          )}
          {scrollAvailability.right && (
            <button
              type="button"
              aria-label="Scroll timeline right"
              className="absolute inset-y-0 right-0 z-10 flex w-8 items-center justify-end bg-[linear-gradient(to_left,var(--console-surface)_55%,transparent)] pr-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand)]"
              onClick={() => scrollTimeline(1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {minimapWindow && (
          <SessionMessageTimelineMinimap
            entries={entries}
            viewportRef={scrollRef}
            visibleWindow={minimapWindow}
          />
        )}
        {tooltip &&
          createPortal(
            <span
              ref={tooltipRef}
              id={tooltip.id}
              role="tooltip"
              className="t-tt session-timeline-floating-tooltip console-mono text-[11px]"
              style={{ left: tooltip.anchorX, top: tooltip.top }}
            >
              {tooltip.text}
            </span>,
            document.body,
          )}
      </div>
    </div>
  );
}
