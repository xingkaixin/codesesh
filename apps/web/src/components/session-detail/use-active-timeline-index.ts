import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  findScrollParent,
  getScrollHeight,
  getScrollTop,
  getViewportHeight,
  isWindowScrollParent,
} from "./scroll-behavior";
import {
  findActiveTimelineIndex,
  findTimelineEdgeIndex,
  type SessionTimelineEntry,
} from "./timeline";
import type { TimelineAnchorRegistry } from "./timeline-anchor-registry";

interface ActiveTimelineIndexOptions {
  rootRef: RefObject<HTMLDivElement | null>;
  entries: SessionTimelineEntry[];
  anchorRegistry: TimelineAnchorRegistry;
}

function getScrollViewport(parent: HTMLElement | Window) {
  const viewportHeight = getViewportHeight(parent);
  return {
    center: isWindowScrollParent(parent)
      ? viewportHeight / 2
      : parent.getBoundingClientRect().top + viewportHeight / 2,
    scrollTop: getScrollTop(parent),
    viewportHeight,
    scrollHeight: getScrollHeight(parent),
  };
}

export function useActiveTimelineIndex({
  rootRef,
  entries,
  anchorRegistry,
}: ActiveTimelineIndexOptions) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const entryIndexes = useMemo(
    () => new Map(entries.map((entry, index) => [entry.anchorId, index])),
    [entries],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || entries.length === 0) return;

    const scrollParent = findScrollParent(root);
    let frame = 0;

    const readAnchorPosition = (anchorId: string, anchor: HTMLElement) => {
      const index = entryIndexes.get(anchorId);
      return index == null ? null : { index, top: anchor.getBoundingClientRect().top };
    };
    const scanAllAnchors = () =>
      Array.from(anchorRegistry.entries()).flatMap(
        ([anchorId, anchor]) => readAnchorPosition(anchorId, anchor) ?? [],
      );

    const visibleAnchors = new Map<string, HTMLElement>();
    const scanVisibleAnchors = () =>
      Array.from(visibleAnchors).flatMap(
        ([anchorId, anchor]) => readAnchorPosition(anchorId, anchor) ?? [],
      );

    const updateActiveEntry = () => {
      const viewport = getScrollViewport(scrollParent);
      const edgeIndex = findTimelineEdgeIndex(
        viewport.scrollTop,
        viewport.viewportHeight,
        viewport.scrollHeight,
        entries.length,
      );
      const positions = intersectionObserver ? scanVisibleAnchors() : scanAllAnchors();
      const nextIndex = edgeIndex ?? findActiveTimelineIndex(positions, viewport.center);
      const nextAnchorId = nextIndex == null ? null : entries[nextIndex]?.anchorId;
      if (nextAnchorId != null) {
        setActiveAnchorId((current) => (current === nextAnchorId ? current : nextAnchorId));
      }
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActiveEntry();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    const observedAnchorIds = new WeakMap<HTMLElement, string>();
    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (observations) => {
              for (const observation of observations) {
                const anchor = observation.target as HTMLElement;
                const anchorId = observedAnchorIds.get(anchor);
                if (!anchorId) continue;
                if (observation.isIntersecting) visibleAnchors.set(anchorId, anchor);
                else visibleAnchors.delete(anchorId);
              }
              scheduleUpdate();
            },
            { root: isWindowScrollParent(scrollParent) ? null : scrollParent, threshold: 0 },
          );

    const observeAnchor = (anchorId: string, anchor: HTMLElement) => {
      observedAnchorIds.set(anchor, anchorId);
      intersectionObserver?.observe(anchor);
      resizeObserver?.observe(anchor);
    };
    const unobserveAnchor = (anchorId: string, anchor: HTMLElement) => {
      intersectionObserver?.unobserve(anchor);
      resizeObserver?.unobserve(anchor);
      observedAnchorIds.delete(anchor);
      visibleAnchors.delete(anchorId);
    };
    if (intersectionObserver) {
      Array.from(anchorRegistry.entries()).forEach(([anchorId, anchor]) =>
        observeAnchor(anchorId, anchor),
      );
    }

    scheduleUpdate();
    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    const unsubscribe = anchorRegistry.subscribe((anchorId, element, previous) => {
      if (previous && previous !== element) unobserveAnchor(anchorId, previous);
      if (element) observeAnchor(anchorId, element);
      scheduleUpdate();
    });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      intersectionObserver?.disconnect();
      resizeObserver?.disconnect();
      unsubscribe();
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [anchorRegistry, entries, entryIndexes, rootRef]);

  return activeAnchorId == null ? 0 : (entryIndexes.get(activeAnchorId) ?? 0);
}
