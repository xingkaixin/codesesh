import { useCallback, useLayoutEffect, useRef } from "react";
import {
  findScrollParent,
  getScrollHeight,
  getScrollTop,
  getViewportHeight,
  scrollParentTo,
} from "./scroll-behavior";

export function useTranscriptScroll(content: unknown, followTail = true, layoutVersion = 0) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<() => void>(() => {});
  const captureRef = useRef<() => number | undefined>(() => undefined);
  const followTailRef = useRef(followTail);
  const captureAnchor = useCallback(() => {
    return captureRef.current();
  }, []);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const parent = findScrollParent(node);
    let atBottom = false;
    let scrollHeight = getScrollHeight(parent);
    // Track both viewport-relative and content-relative positions so browser scroll-clamping
    // is not double-subtracted while active user scrolling is never undone.
    let anchor: { id: string; viewportTop: number; contentTop: number } | undefined;
    let captureFrame = 0;
    let programmaticScrollTop: number | null = null;

    const getParentTop = () =>
      parent === window ? 0 : (parent as HTMLElement).getBoundingClientRect().top;

    const capture = () => {
      scrollHeight = getScrollHeight(parent);
      const currentScrollTop = getScrollTop(parent);
      atBottom =
        followTailRef.current && scrollHeight - currentScrollTop - getViewportHeight(parent) <= 48;
      const parentTop = getParentTop();
      const rows = node.querySelectorAll<HTMLElement>("[data-message-id]");
      anchor = undefined;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > parentTop) {
          const rowViewportTop = rect.top - parentTop;
          anchor = {
            id: row.dataset.messageId!,
            viewportTop: rowViewportTop,
            contentTop: rowViewportTop + currentScrollTop,
          };
          return Number(row.parentElement?.dataset.listIndex);
        }
      }
    };

    const flushCapture = () => {
      if (captureFrame) {
        cancelAnimationFrame(captureFrame);
        captureFrame = 0;
      }
      return capture();
    };

    const scheduleCapture = () => {
      if (captureFrame) return;
      captureFrame = requestAnimationFrame(() => {
        captureFrame = 0;
        capture();
      });
    };

    const scrollTo = (top: number) => {
      const clamped = Math.max(
        0,
        Math.min(top, Math.max(0, scrollHeight - getViewportHeight(parent))),
      );
      if (Math.abs(getScrollTop(parent) - clamped) <= 1) return;
      programmaticScrollTop = clamped;
      scrollParentTo(parent, clamped);
    };

    const restore = () => {
      const previousScrollHeight = scrollHeight;
      const currentScrollTop = getScrollTop(parent);
      const viewportHeight = getViewportHeight(parent);
      const hadPendingScroll = captureFrame !== 0;
      if (hadPendingScroll) {
        cancelAnimationFrame(captureFrame);
        captureFrame = 0;
        atBottom =
          followTailRef.current && previousScrollHeight - currentScrollTop - viewportHeight <= 48;
      }
      scrollHeight = getScrollHeight(parent);
      if (atBottom && followTailRef.current) {
        const bottom = Math.max(0, scrollHeight - viewportHeight);
        if (Math.abs(currentScrollTop - bottom) > 1) scrollTo(bottom);
      } else if (anchor) {
        const parentTop = getParentTop();
        const rows = node.querySelectorAll<HTMLElement>("[data-message-id]");
        for (const row of rows) {
          if (row.dataset.messageId === anchor.id) {
            const rowViewportTop = row.getBoundingClientRect().top - parentTop;
            const delta = hadPendingScroll
              ? rowViewportTop + currentScrollTop - anchor.contentTop
              : rowViewportTop - anchor.viewportTop;
            if (Math.abs(delta) > 1) scrollTo(currentScrollTop + delta);
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
      scheduleCapture();
    };

    capture();
    restoreRef.current = restore;
    captureRef.current = flushCapture;
    parent.addEventListener("scroll", handleScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    observer?.observe(node);
    return () => {
      if (captureFrame) cancelAnimationFrame(captureFrame);
      parent.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
      restoreRef.current = () => {};
      captureRef.current = () => undefined;
    };
  }, []);

  useLayoutEffect(() => {
    restoreRef.current();
    followTailRef.current = followTail;
  }, [content, followTail, layoutVersion]);
  return { containerRef, captureAnchor };
}
