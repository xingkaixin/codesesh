import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MessagePart } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import type { FilteredSessionMessage } from "./toc";
import { MessageItem } from "./message-rendering";

const MESSAGE_LIST_GAP_PX = 32;
export const VIRTUALIZED_MESSAGE_THRESHOLD = 80;
const VIRTUALIZED_MESSAGE_ESTIMATE_PX = 280;
const VIRTUALIZED_MESSAGE_OVERSCAN = 6;

export interface MessageListHandle {
  scrollToIndex: (index: number) => void;
}

interface MessageListProps {
  messages: FilteredSessionMessage[];
  toolAnchorIds: Map<MessagePart, string>;
  sessionAgentKey: string;
  baseDirectory: string;
  highlightQuery?: string;
  apiRef: { current: MessageListHandle | null };
}

interface VirtualMeasurement {
  start: number;
  end: number;
}

type ScrollParent = HTMLElement | Window;

function isWindowScrollParent(parent: ScrollParent): parent is Window {
  return parent === window;
}

function buildVirtualMeasurements(
  count: number,
  heights: Array<number | undefined>,
): {
  items: VirtualMeasurement[];
  totalSize: number;
} {
  const items: VirtualMeasurement[] = [];
  let offset = 0;

  for (let index = 0; index < count; index += 1) {
    const height = heights[index] ?? VIRTUALIZED_MESSAGE_ESTIMATE_PX;
    const start = offset;
    const end = start + height;
    items.push({ start, end });
    offset = end + (index === count - 1 ? 0 : MESSAGE_LIST_GAP_PX);
  }

  return { items, totalSize: offset };
}

function findFirstEndAfter(items: VirtualMeasurement[], offset: number) {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];
    if (item && item.end < offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function findFirstStartAfter(items: VirtualMeasurement[], offset: number) {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];
    if (item && item.start <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
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

function getScrollTop(parent: ScrollParent) {
  return isWindowScrollParent(parent) ? window.scrollY : parent.scrollTop;
}

function getViewportHeight(parent: ScrollParent) {
  return isWindowScrollParent(parent) ? window.innerHeight || 900 : parent.clientHeight;
}

function getListTop(node: HTMLElement, parent: ScrollParent) {
  if (isWindowScrollParent(parent)) return node.getBoundingClientRect().top + window.scrollY;

  const parentRect = parent.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  return parent.scrollTop + nodeRect.top - parentRect.top;
}

function scrollParentTo(parent: ScrollParent, top: number) {
  if (isWindowScrollParent(parent)) {
    window.scrollTo({ top, behavior: "auto" });
    return;
  }

  parent.scrollTo({ top, behavior: "auto" });
}

export function MessageList({
  messages,
  toolAnchorIds,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
  apiRef,
}: MessageListProps) {
  const shouldVirtualize = messages.length > VIRTUALIZED_MESSAGE_THRESHOLD;

  useEffect(() => {
    if (!shouldVirtualize) apiRef.current = null;
  }, [apiRef, shouldVirtualize]);

  if (shouldVirtualize) {
    return (
      <VirtualizedMessageList
        messages={messages}
        toolAnchorIds={toolAnchorIds}
        sessionAgentKey={sessionAgentKey}
        baseDirectory={baseDirectory}
        highlightQuery={highlightQuery}
        apiRef={apiRef}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {messages.map(({ msg, blocks, index }) => (
        <MessageItem
          key={`${msg.id}:${index}`}
          msg={msg}
          blocks={blocks}
          toolAnchorIds={toolAnchorIds}
          formatTokens={formatTokens}
          sessionAgentKey={sessionAgentKey}
          baseDirectory={baseDirectory}
          highlightQuery={highlightQuery}
        />
      ))}
    </div>
  );
}

function VirtualizedMessageList({
  messages,
  toolAnchorIds,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
  apiRef,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<ScrollParent | null>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Array<number | undefined>>([]);
  const [forcedIndex, setForcedIndex] = useState<number | null>(null);
  const [viewport, setViewport] = useState(() => ({
    scrollTop: 0,
    height: 900,
    listTop: 0,
  }));
  const viewportRef = useRef(viewport);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const updateViewport = useCallback(() => {
    if (typeof window === "undefined") return;

    const node = containerRef.current;
    const scrollParent = node ? findScrollParent(node) : window;
    scrollParentRef.current = scrollParent;
    const listTop = node ? getListTop(node, scrollParent) : 0;
    const next = {
      scrollTop: getScrollTop(scrollParent),
      height: getViewportHeight(scrollParent),
      listTop,
    };

    const current = viewportRef.current;
    if (
      Math.abs(current.scrollTop - next.scrollTop) < 1 &&
      Math.abs(current.height - next.height) < 1 &&
      Math.abs(current.listTop - next.listTop) < 1
    ) {
      return;
    }

    viewportRef.current = next;
    setViewport(next);
  }, []);

  useEffect(() => {
    updateViewport();
    const scrollParent = scrollParentRef.current ?? window;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateViewport();
      });
    };

    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    const interval = window.setInterval(updateViewport, 100);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleUpdate);
      if (containerRef.current) observer.observe(containerRef.current);
      if (!isWindowScrollParent(scrollParent)) observer.observe(scrollParent);
      if (document.body) observer.observe(document.body);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.clearInterval(interval);
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [updateViewport]);

  useEffect(() => {
    setMeasuredHeights([]);
    setForcedIndex(null);
    updateViewport();
  }, [messages, updateViewport]);

  const measurements = useMemo(
    () => buildVirtualMeasurements(messages.length, measuredHeights),
    [measuredHeights, messages.length],
  );

  const measureItem = useCallback((index: number, height: number) => {
    const nextHeight = Math.ceil(height);
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;

    setMeasuredHeights((current) => {
      const currentHeight = current[index];
      if (currentHeight != null && Math.abs(currentHeight - nextHeight) <= 1) return current;

      const next = [...current];
      next[index] = nextHeight;
      return next;
    });
  }, []);

  const virtualItems = useMemo(() => {
    if (messages.length === 0) return [];

    const localStart = Math.max(0, viewport.scrollTop - viewport.listTop);
    const localEnd = localStart + viewport.height;
    const startIndex = Math.max(
      0,
      findFirstEndAfter(measurements.items, localStart) - VIRTUALIZED_MESSAGE_OVERSCAN,
    );
    const endIndex = Math.min(
      messages.length,
      findFirstStartAfter(measurements.items, localEnd) + VIRTUALIZED_MESSAGE_OVERSCAN,
    );

    const items: Array<{ index: number; start: number }> = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const measurement = measurements.items[index];
      if (measurement) items.push({ index, start: measurement.start });
    }

    if (forcedIndex != null && forcedIndex >= 0 && forcedIndex < messages.length) {
      const measurement = measurements.items[forcedIndex];
      if (measurement && !items.some((item) => item.index === forcedIndex)) {
        items.push({ index: forcedIndex, start: measurement.start });
        items.sort((a, b) => a.start - b.start);
      }
    }

    return items;
  }, [forcedIndex, measurements, messages.length, viewport]);

  const scrollToIndex = useCallback(
    (index: number) => {
      if (typeof window === "undefined") return;
      const measurement = measurements.items[index];
      if (!measurement) return;

      setForcedIndex(index);
      const node = containerRef.current;
      const scrollParent = node ? findScrollParent(node) : (scrollParentRef.current ?? window);
      scrollParentRef.current = scrollParent;
      const listTop = node ? getListTop(node, scrollParent) : 0;
      const nextTop = Math.max(0, listTop + measurement.start - 24);
      scrollParentTo(scrollParent, nextTop);
      const nextViewport = {
        scrollTop: nextTop,
        height: getViewportHeight(scrollParent),
        listTop,
      };
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
    },
    [measurements.items],
  );

  useEffect(() => {
    apiRef.current = { scrollToIndex };
    return () => {
      if (apiRef.current?.scrollToIndex === scrollToIndex) apiRef.current = null;
    };
  }, [apiRef, scrollToIndex]);

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      style={{ height: Math.max(1, measurements.totalSize) }}
    >
      {virtualItems.map(({ index, start }) => {
        const item = messages[index];
        if (!item) return null;

        return (
          <VirtualizedMessageRow
            key={`${item.msg.id}:${item.index}`}
            index={index}
            top={start}
            onMeasure={measureItem}
          >
            <MessageItem
              msg={item.msg}
              blocks={item.blocks}
              toolAnchorIds={toolAnchorIds}
              formatTokens={formatTokens}
              sessionAgentKey={sessionAgentKey}
              baseDirectory={baseDirectory}
              highlightQuery={highlightQuery}
            />
          </VirtualizedMessageRow>
        );
      })}
    </div>
  );
}

function VirtualizedMessageRow({
  index,
  top,
  onMeasure,
  children,
}: {
  index: number;
  top: number;
  onMeasure: (index: number, height: number) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = rowRef.current;
    if (!node) return;

    const measure = () => onMeasure(index, node.getBoundingClientRect().height);
    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  return (
    <div
      ref={rowRef}
      className="absolute left-0 top-0 w-full"
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}
