import { useLayoutEffect, useRef } from "react";
import {
  findScrollParent,
  getScrollHeight,
  getScrollTop,
  getViewportHeight,
  scrollParentTo,
} from "./scroll-behavior";

const USER_SCROLL_IDLE_MS = 150;

export function useTranscriptScroll(content: unknown, followTail = true) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<() => void>(() => {});
  const followTailRef = useRef(followTail);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const parent = findScrollParent(node);
    let atBottom = false;
    let scrollHeight = getScrollHeight(parent);
    let anchor: { id: string; top: number } | undefined;
    let captureFrame = 0;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let userScrolling = false;
    let programmaticScrollTop: number | null = null;

    const capture = () => {
      scrollHeight = getScrollHeight(parent);
      atBottom =
        followTailRef.current &&
        scrollHeight - getScrollTop(parent) - getViewportHeight(parent) <= 48;
      const viewportTop =
        parent === window ? 0 : (parent as HTMLElement).getBoundingClientRect().top;
      const rows = node.querySelectorAll<HTMLElement>("[data-message-id]");
      anchor = undefined;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > viewportTop) {
          anchor = { id: row.dataset.messageId!, top: rect.top };
          break;
        }
      }
    };

    const scheduleCapture = () => {
      if (captureFrame) return;
      captureFrame = requestAnimationFrame(() => {
        captureFrame = 0;
        capture();
      });
    };

    const scrollTo = (top: number) => {
      programmaticScrollTop = top;
      scrollParentTo(parent, top);
    };

    const restore = () => {
      const previousScrollHeight = scrollHeight;
      const hadPendingScroll = captureFrame !== 0;
      if (hadPendingScroll) {
        cancelAnimationFrame(captureFrame);
        captureFrame = 0;
        atBottom =
          followTailRef.current &&
          previousScrollHeight - getScrollTop(parent) - getViewportHeight(parent) <= 48;
      }
      scrollHeight = getScrollHeight(parent);
      if (atBottom && followTailRef.current) {
        const bottom = Math.max(0, scrollHeight - getViewportHeight(parent));
        if (Math.abs(getScrollTop(parent) - bottom) > 1) scrollTo(bottom);
      } else if (!hadPendingScroll && anchor) {
        const rows = node.querySelectorAll<HTMLElement>("[data-message-id]");
        for (const row of rows) {
          if (row.dataset.messageId === anchor.id) {
            const delta = row.getBoundingClientRect().top - anchor.top;
            if (Math.abs(delta) > 1) scrollTo(getScrollTop(parent) + delta);
            break;
          }
        }
      }
      capture();
    };

    const handleScroll = () => {
      if (programmaticScrollTop !== null) {
        const isProgrammatic = Math.abs(getScrollTop(parent) - programmaticScrollTop) <= 1;
        programmaticScrollTop = null;
        if (isProgrammatic) return;
      }
      userScrolling = true;
      if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        scrollIdleTimer = undefined;
        userScrolling = false;
        if (!captureFrame) capture();
      }, USER_SCROLL_IDLE_MS);
      scheduleCapture();
    };

    const handleResize = () => {
      // Virtualized rows mount and measure during scrolling; restoring here fights the user's scroll.
      if (userScrolling || captureFrame !== 0) {
        scrollHeight = getScrollHeight(parent);
        scheduleCapture();
        return;
      }
      restore();
    };

    capture();
    restoreRef.current = restore;
    parent.addEventListener("scroll", handleScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    observer?.observe(node);
    return () => {
      if (captureFrame) cancelAnimationFrame(captureFrame);
      if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer);
      parent.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
      restoreRef.current = () => {};
    };
  }, []);

  useLayoutEffect(() => {
    restoreRef.current();
    followTailRef.current = followTail;
  }, [content, followTail]);
  return containerRef;
}
