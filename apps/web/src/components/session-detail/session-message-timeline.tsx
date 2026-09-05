import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { memo, useCallback, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "../ui/icons";
import type { SessionAnchorScrollBehavior } from "./scroll-behavior";
import type { SessionTimelineEntry, SessionTimelineEntryKind } from "./timeline";
import type { TimelineAnchorRegistry } from "./timeline-anchor-registry";
import {
  getTrackLayout,
  getVirtualizedSegmentStyle,
  TIMELINE_SEGMENT_MIN_WIDTH,
} from "./session-message-timeline-layout";
import { SessionMessageTimelineMinimap } from "./session-message-timeline-minimap";
import {
  SessionMessageTimelineTooltip,
  type TimelineTooltip,
  useSessionMessageTimelineTooltip,
} from "./session-message-timeline-tooltip";
import { useActiveTimelineIndex } from "./use-active-timeline-index";
import { useSessionMessageTimelineNavigation } from "./use-session-message-timeline-navigation";
import { useSessionMessageTimelineViewport } from "./use-session-message-timeline-viewport";

export { VIRTUALIZED_TIMELINE_THRESHOLD } from "./session-message-timeline-layout";

interface SessionMessageTimelineProps {
  entries: SessionTimelineEntry[];
  anchorRegistry: TimelineAnchorRegistry;
  onNavigate: (entry: SessionTimelineEntry, behavior: SessionAnchorScrollBehavior) => void;
}

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
  useLocale();

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
        aria-label={t("Go to {0}", [entry.tooltip])}
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
  useLocale();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeIndex = useActiveTimelineIndex({ rootRef, entries, anchorRegistry });
  const trackLayout = getTrackLayout(entries.length);
  const {
    scrollRef,
    trackRef,
    virtualized,
    renderStart,
    renderEnd,
    scrollAvailability,
    minimapWindow,
    update: updateViewport,
    scrollByPage,
    focusIndex,
  } = useSessionMessageTimelineViewport({
    activeIndex,
    entryCount: entries.length,
    gapWidth: trackLayout.gapWidth,
  });
  const {
    tooltip,
    tooltipRef,
    show: showTooltip,
    hide: hideTooltip,
    handleScroll: handleTooltipScroll,
  } = useSessionMessageTimelineTooltip();
  const {
    handleKeyDown,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleClick,
  } = useSessionMessageTimelineNavigation({
    entries,
    trackRef,
    focusIndex,
    onNavigate,
  });
  const renderedEntries = useMemo(
    () =>
      entries
        .slice(renderStart, renderEnd)
        .map((entry, offset) => ({ entry, index: renderStart + offset })),
    [entries, renderEnd, renderStart],
  );

  const handleTimelineScroll = useCallback(() => {
    updateViewport();
    handleTooltipScroll();
  }, [handleTooltipScroll, updateViewport]);

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
            aria-label={t("Session message timeline")}
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
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onClick={handleClick}
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
              aria-label={t("Scroll timeline left")}
              className="absolute inset-y-0 left-0 z-10 flex w-8 items-center justify-start bg-[linear-gradient(to_right,var(--console-surface)_55%,transparent)] pl-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand)]"
              onClick={() => scrollByPage(-1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
          )}
          {scrollAvailability.right && (
            <button
              type="button"
              aria-label={t("Scroll timeline right")}
              className="absolute inset-y-0 right-0 z-10 flex w-8 items-center justify-end bg-[linear-gradient(to_left,var(--console-surface)_55%,transparent)] pr-0.5 text-[var(--console-muted)] hover:text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand)]"
              onClick={() => scrollByPage(1)}
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
        <SessionMessageTimelineTooltip tooltip={tooltip} tooltipRef={tooltipRef} />
      </div>
    </div>
  );
}
