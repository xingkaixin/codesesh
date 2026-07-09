import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  findActiveTimelineIndex,
  findTimelineEdgeIndex,
  findTimelineIndexAtPointer,
  type SessionTimelineEntry,
  type SessionTimelineEntryKind,
} from "./timeline";

type TimelineScrollBehavior = "auto" | "smooth";
type ScrollParent = HTMLElement | Window;

interface SessionMessageTimelineProps {
  entries: SessionTimelineEntry[];
  onNavigate: (entry: SessionTimelineEntry, behavior: TimelineScrollBehavior) => void;
}

interface TimelineTooltip {
  entryId: string;
  id: string;
  text: string;
  anchorX: number;
  top: number;
  source: "focus" | "pointer";
}

const TIMELINE_SEGMENT_MIN_WIDTH = 10;
const TIMELINE_SCROLL_EDGE_TOLERANCE = 1;
const TIMELINE_TOOLTIP_VIEWPORT_PADDING = 8;

const KIND_CLASS: Record<SessionTimelineEntryKind, string> = {
  user: "bg-[var(--timeline-user)]",
  agent: "bg-[var(--timeline-agent)]",
  tool: "bg-[var(--timeline-tool)]",
};

const KIND_FALLBACK_COLOR: Record<SessionTimelineEntryKind, string> = {
  user: "#a85f82",
  agent: "#5e86aa",
  tool: "#a3a3a3",
};

interface MinimapWindow {
  start: number;
  size: number;
}

function findScrollParent(node: HTMLElement): ScrollParent {
  let parent = node.parentElement;

  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return parent;
    parent = parent.parentElement;
  }

  return window;
}

function isWindowScrollParent(parent: ScrollParent): parent is Window {
  return parent === window;
}

function getScrollViewport(parent: ScrollParent) {
  if (isWindowScrollParent(parent)) {
    const viewportHeight = window.innerHeight || 900;
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    return {
      center: viewportHeight / 2,
      scrollTop: window.scrollY || scrollingElement.scrollTop,
      viewportHeight,
      scrollHeight: scrollingElement.scrollHeight,
    };
  }

  const rect = parent.getBoundingClientRect();
  return {
    center: rect.top + parent.clientHeight / 2,
    scrollTop: parent.scrollTop,
    viewportHeight: parent.clientHeight,
    scrollHeight: parent.scrollHeight,
  };
}

function getTrackLayout(entryCount: number) {
  const gap =
    entryCount > 80
      ? { className: "gap-px", width: 1 }
      : entryCount > 40
        ? { className: "gap-0.5", width: 2 }
        : { className: "gap-1", width: 4 };
  return {
    gapClassName: gap.className,
    minWidth: entryCount * TIMELINE_SEGMENT_MIN_WIDTH + Math.max(0, entryCount - 1) * gap.width,
  };
}

export function SessionMessageTimeline({ entries, onNavigate }: SessionMessageTimelineProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipTriggerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, lastIndex: -1 });
  const suppressClickRef = useRef(false);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapDragRef = useRef<{ pointerId: number; grabOffset: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [tooltip, setTooltip] = useState<TimelineTooltip | null>(null);
  const [scrollAvailability, setScrollAvailability] = useState({ left: false, right: false });
  const [minimapWindow, setMinimapWindow] = useState<MinimapWindow | null>(null);
  const entryIndexes = useMemo(
    () => new Map(entries.map((entry, index) => [entry.anchorId, index])),
    [entries],
  );
  const trackLayout = getTrackLayout(entries.length);

  const updateScrollAvailability = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
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
  }, []);

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
    setActiveIndex(0);
    const root = rootRef.current;
    if (!root || entries.length === 0) return;

    const detail = root.closest<HTMLElement>('[data-testid="session-detail"]');
    const scrollParent = findScrollParent(root);
    let frame = 0;
    const updateActiveEntry = () => {
      const viewport = getScrollViewport(scrollParent);
      const edgeIndex = findTimelineEdgeIndex(
        viewport.scrollTop,
        viewport.viewportHeight,
        viewport.scrollHeight,
        entries.length,
      );
      const positions = Array.from(
        detail?.querySelectorAll<HTMLElement>("[data-session-timeline-anchor]") ?? [],
      ).flatMap((anchor) => {
        const anchorId = anchor.dataset.sessionTimelineAnchor;
        const index = anchorId ? entryIndexes.get(anchorId) : undefined;
        return index == null ? [] : [{ index, top: anchor.getBoundingClientRect().top }];
      });
      const nextIndex = edgeIndex ?? findActiveTimelineIndex(positions, viewport.center);
      if (nextIndex != null) {
        setActiveIndex((current) => (current === nextIndex ? current : nextIndex));
      }
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActiveEntry();
      });
    };

    scheduleUpdate();
    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    if (detail) resizeObserver?.observe(detail);

    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleUpdate);
    if (detail) mutationObserver?.observe(detail, { childList: true, subtree: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [entries.length, entryIndexes]);

  useEffect(() => {
    const scrollViewport = scrollRef.current;
    const segment = trackRef.current?.querySelector<HTMLElement>(
      `[data-timeline-index="${activeIndex}"]`,
    );
    if (!scrollViewport || !segment) return;

    const viewportRect = scrollViewport.getBoundingClientRect();
    const segmentRect = segment.getBoundingClientRect();
    if (segmentRect.left < viewportRect.left) {
      scrollViewport.scrollLeft -= viewportRect.left - segmentRect.left;
    } else if (segmentRect.right > viewportRect.right) {
      scrollViewport.scrollLeft += segmentRect.right - viewportRect.right;
    }
  }, [activeIndex]);

  const minimapVisible = minimapWindow != null;

  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    if (!canvas || !minimapVisible) return;

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
      const colors: Record<SessionTimelineEntryKind, string> = {
        user: styles.getPropertyValue("--timeline-user").trim() || KIND_FALLBACK_COLOR.user,
        agent: styles.getPropertyValue("--timeline-agent").trim() || KIND_FALLBACK_COLOR.agent,
        tool: styles.getPropertyValue("--timeline-tool").trim() || KIND_FALLBACK_COLOR.tool,
      };
      entries.forEach((entry, index) => {
        const x0 = (index / entries.length) * width;
        const x1 = ((index + 1) / entries.length) * width;
        context.fillStyle = colors[entry.kind];
        context.fillRect(x0, 0, Math.max(x1 - x0, 0.5), height);
      });
    };

    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [entries, minimapVisible]);

  const scrollToMinimapRatio = useCallback((ratio: number, grabOffset: number) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollLeft = (ratio - grabOffset) * viewport.scrollWidth;
  }, []);

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
    (clientX: number, behavior: TimelineScrollBehavior) => {
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

  return (
    <div className="sticky top-0 z-20 -mx-2 bg-[var(--console-bg)] px-2 py-3">
      <div
        ref={rootRef}
        className="session-message-timeline relative rounded-sm border border-[var(--console-border)] bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]"
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
              className={`grid h-5 w-full select-none items-stretch ${trackLayout.gapClassName}`}
              style={{
                gridTemplateColumns: `repeat(${entries.length}, minmax(${TIMELINE_SEGMENT_MIN_WIDTH}px, 1fr))`,
                minWidth: `${trackLayout.minWidth}px`,
              }}
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

                const indexValue = (event.target as HTMLElement).closest<HTMLButtonElement>(
                  "[data-timeline-index]",
                )?.dataset.timelineIndex;
                const index = indexValue == null ? null : Number(indexValue);
                const entry =
                  index == null || !Number.isInteger(index) ? undefined : entries[index];
                if (entry) {
                  onNavigate(entry, "smooth");
                  return;
                }
                navigateFromPointer(event.clientX, "smooth");
              }}
            >
              {entries.map((entry, index) => {
                const tooltipId = `timeline-tooltip-${entry.id}`;
                const isActive = index === activeIndex;
                return (
                  <span key={entry.id} className="t-tt-wrap session-timeline-item min-w-0">
                    <button
                      type="button"
                      data-timeline-index={index}
                      aria-current={isActive ? "location" : undefined}
                      aria-describedby={tooltip?.entryId === entry.id ? tooltipId : undefined}
                      aria-label={`Go to ${entry.tooltip}`}
                      className={`t-tt-trigger session-timeline-segment h-full w-full rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--console-text)] ${KIND_CLASS[entry.kind]}`}
                      onPointerEnter={(event) => showTooltip(entry, event.currentTarget, "pointer")}
                      onPointerLeave={() => hideTooltip(entry.id)}
                      onFocus={(event) => showTooltip(entry, event.currentTarget, "focus")}
                      onBlur={() => hideTooltip(entry.id)}
                    />
                  </span>
                );
              })}
            </div>
          </div>
          {scrollAvailability.left && (
            <button
              type="button"
              aria-label="Scroll timeline left"
              className="absolute inset-y-0 left-0 z-10 flex w-8 items-center justify-start bg-[linear-gradient(to_right,#fff_55%,transparent)] pl-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--console-text)]"
              onClick={() => scrollTimeline(-1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
          )}
          {scrollAvailability.right && (
            <button
              type="button"
              aria-label="Scroll timeline right"
              className="absolute inset-y-0 right-0 z-10 flex w-8 items-center justify-end bg-[linear-gradient(to_left,#fff_55%,transparent)] pr-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--console-text)]"
              onClick={() => scrollTimeline(1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {minimapWindow && (
          <div
            data-testid="session-timeline-minimap"
            role="scrollbar"
            aria-controls="session-timeline-viewport"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((minimapWindow.start / (1 - minimapWindow.size)) * 100)}
            className="session-timeline-minimap relative mt-2 h-2.5 cursor-pointer touch-none select-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              const ratio = (event.clientX - rect.left) / rect.width;
              const withinWindow =
                ratio >= minimapWindow.start && ratio <= minimapWindow.start + minimapWindow.size;
              const grabOffset = withinWindow
                ? ratio - minimapWindow.start
                : minimapWindow.size / 2;
              minimapDragRef.current = { pointerId: event.pointerId, grabOffset };
              event.currentTarget.setPointerCapture(event.pointerId);
              scrollToMinimapRatio(ratio, grabOffset);
            }}
            onPointerMove={(event) => {
              const drag = minimapDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              scrollToMinimapRatio((event.clientX - rect.left) / rect.width, drag.grabOffset);
            }}
            onPointerUp={(event) => {
              minimapDragRef.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              minimapDragRef.current = null;
            }}
          >
            <canvas
              ref={minimapCanvasRef}
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
            />
            <div
              data-testid="session-timeline-minimap-window"
              className="session-timeline-minimap-window absolute inset-y-0"
              style={{
                left: `${minimapWindow.start * 100}%`,
                width: `${minimapWindow.size * 100}%`,
              }}
            />
          </div>
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
