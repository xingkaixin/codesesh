import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { getActivationScrollBehavior, type SessionAnchorScrollBehavior } from "./scroll-behavior";
import { findTimelineIndexAtPointer, type SessionTimelineEntry } from "./timeline";

interface TimelineNavigationOptions {
  entries: SessionTimelineEntry[];
  trackRef: RefObject<HTMLDivElement | null>;
  focusIndex: (index: number) => void;
  onNavigate: (entry: SessionTimelineEntry, behavior: SessionAnchorScrollBehavior) => void;
}

export function useSessionMessageTimelineNavigation({
  entries,
  trackRef,
  focusIndex,
  onNavigate,
}: TimelineNavigationOptions) {
  const dragRef = useRef({ active: false, moved: false, startX: 0, lastIndex: -1 });
  const suppressClickRef = useRef(false);

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
    [entries, onNavigate, trackRef],
  );

  const handleKeyDown = useCallback(
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
      focusIndex(nextIndex);
    },
    [entries.length, focusIndex],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { active: true, moved: false, startX: event.clientX, lastIndex: -1 };
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag.active) return;
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 3) return;
        drag.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      suppressClickRef.current = true;
      navigateFromPointer(event.clientX, "auto");
    },
    [navigateFromPointer],
  );

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handlePointerCancel = useCallback(() => {
    dragRef.current.active = false;
    suppressClickRef.current = false;
  }, []);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) return;
      const behavior = getActivationScrollBehavior(event.detail);
      const indexValue = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-timeline-index]",
      )?.dataset.timelineIndex;
      const index = indexValue == null ? null : Number(indexValue);
      const entry = index == null || !Number.isInteger(index) ? undefined : entries[index];
      if (entry) {
        onNavigate(entry, behavior);
        return;
      }
      navigateFromPointer(event.clientX, behavior);
    },
    [entries, navigateFromPointer, onNavigate],
  );

  return {
    handleKeyDown,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleClick,
  };
}
