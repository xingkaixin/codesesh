import { useLayoutEffect, useRef } from "react";
import {
  findScrollParent,
  getScrollHeight,
  getScrollTop,
  getViewportHeight,
  scrollParentTo,
} from "./scroll-behavior";

export function useTranscriptScroll(content: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const parent = findScrollParent(node);
    let atBottom = false;
    let scrollHeight = getScrollHeight(parent);
    let anchor: { id: string; top: number } | undefined;
    const capture = () => {
      if (getScrollHeight(parent) !== scrollHeight) {
        restore();
        return;
      }
      atBottom = getScrollHeight(parent) - getScrollTop(parent) - getViewportHeight(parent) <= 48;
      const viewportTop =
        parent === window ? 0 : (parent as HTMLElement).getBoundingClientRect().top;
      const rows = node.querySelectorAll<HTMLElement>("[data-message-id]");
      const visible = Array.from(rows).find(
        (row) => row.getBoundingClientRect().bottom > viewportTop,
      );
      anchor = visible
        ? { id: visible.dataset.messageId!, top: visible.getBoundingClientRect().top }
        : undefined;
    };
    const restore = () => {
      scrollHeight = getScrollHeight(parent);
      if (atBottom) {
        const bottom = Math.max(0, getScrollHeight(parent) - getViewportHeight(parent));
        if (Math.abs(getScrollTop(parent) - bottom) > 1) scrollParentTo(parent, bottom);
      } else if (anchor) {
        const row = Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]")).find(
          (row) => row.dataset.messageId === anchor?.id,
        );
        if (row) {
          const delta = row.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) > 1) scrollParentTo(parent, getScrollTop(parent) + delta);
        }
      }
    };
    capture();
    restoreRef.current = restore;
    parent.addEventListener("scroll", capture, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    observer?.observe(node);
    return () => {
      parent.removeEventListener("scroll", capture);
      observer?.disconnect();
      restoreRef.current = () => {};
    };
  }, []);

  useLayoutEffect(() => restoreRef.current(), [content]);
  return containerRef;
}
