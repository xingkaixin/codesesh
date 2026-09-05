import { useLocale } from "../../hooks/useLocale";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentInfo, SessionHead } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import type { FilteredSessionMessage } from "./toc";
import { MessageItem } from "./message-rendering";
import { HeightIndex } from "./height-index";
import {
  findScrollParent,
  getElementTop,
  getScrollTop,
  getViewportHeight,
  isWindowScrollParent,
  scrollParentTo,
  type ScrollParent,
} from "./scroll-behavior";
import {
  TimelineAnchorRegistryProvider,
  type TimelineAnchorRegistry,
} from "./timeline-anchor-registry";

const MESSAGE_LIST_GAP_PX = 32;
export const VIRTUALIZED_MESSAGE_THRESHOLD = 80;
const VIRTUALIZED_MESSAGE_ESTIMATE_PX = 280;
const VIRTUALIZED_MESSAGE_OVERSCAN = 6;

export interface MessageListHandle {
  scrollToIndex: (index: number) => void;
}

interface MessageListProps {
  messages: FilteredSessionMessage[];
  sessionAgentKey: string;
  agent?: AgentInfo;
  baseDirectory: string;
  highlightQuery?: string;
  childSessionById?: ReadonlyMap<string, SessionHead>;
  apiRef: { current: MessageListHandle | null };
  anchorRegistry: TimelineAnchorRegistry;
}

export function MessageList({
  messages,
  sessionAgentKey,
  agent,
  baseDirectory,
  highlightQuery,
  childSessionById,
  apiRef,
  anchorRegistry,
}: MessageListProps) {
  useLocale();

  const shouldVirtualize = messages.length > VIRTUALIZED_MESSAGE_THRESHOLD;

  useEffect(() => {
    if (!shouldVirtualize) apiRef.current = null;
  }, [apiRef, shouldVirtualize]);

  if (shouldVirtualize) {
    return (
      <VirtualizedMessageList
        messages={messages}
        sessionAgentKey={sessionAgentKey}
        agent={agent}
        baseDirectory={baseDirectory}
        highlightQuery={highlightQuery}
        childSessionById={childSessionById}
        apiRef={apiRef}
        anchorRegistry={anchorRegistry}
      />
    );
  }

  return (
    <TimelineAnchorRegistryProvider registry={anchorRegistry}>
      <div className="flex min-w-0 flex-col gap-8">
        {messages.map(({ msg, blocks, index }) => (
          <MessageItem
            key={`${msg.id}:${index}`}
            messageIndex={index}
            msg={msg}
            blocks={blocks}
            formatTokens={formatTokens}
            sessionAgentKey={sessionAgentKey}
            agent={agent}
            baseDirectory={baseDirectory}
            highlightQuery={highlightQuery}
            childSessionById={childSessionById}
          />
        ))}
      </div>
    </TimelineAnchorRegistryProvider>
  );
}

function VirtualizedMessageList({
  messages,
  sessionAgentKey,
  agent,
  baseDirectory,
  highlightQuery,
  childSessionById,
  apiRef,
  anchorRegistry,
}: MessageListProps) {
  const locale = useLocale();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<ScrollParent | null>(null);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const pendingMeasureFrameRef = useRef(0);
  const [forcedItem, setForcedItem] = useState<{
    heightIndex: HeightIndex;
    index: number;
  } | null>(null);
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
    if (typeof window === "undefined") return null;

    const node = containerRef.current;
    const scrollParent = node ? findScrollParent(node) : window;
    scrollParentRef.current = scrollParent;
    const listTop = node ? getElementTop(scrollParent, node) : 0;
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
      return scrollParent;
    }

    viewportRef.current = next;
    setViewport(next);
    return scrollParent;
  }, []);

  useEffect(() => {
    let frame = 0;
    let scrollParent: ScrollParent | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const bindScrollParent = (next: ScrollParent) => {
      if (scrollParent === next) return;

      if (scrollParent) {
        scrollParent.removeEventListener("scroll", scheduleUpdate);
        if (resizeObserver && !isWindowScrollParent(scrollParent)) {
          resizeObserver.unobserve(scrollParent);
        }
      }

      scrollParent = next;
      scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
      if (resizeObserver && !isWindowScrollParent(scrollParent)) {
        resizeObserver.observe(scrollParent);
      }
    };

    const refreshViewport = () => {
      const nextScrollParent = updateViewport();
      if (nextScrollParent) bindScrollParent(nextScrollParent);
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refreshViewport();
      });
    };

    window.addEventListener("resize", scheduleUpdate);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      if (containerRef.current) resizeObserver.observe(containerRef.current);
      if (document.body) resizeObserver.observe(document.body);
    }

    const layoutObserver = new MutationObserver(scheduleUpdate);
    let ancestor = containerRef.current?.parentElement;
    while (ancestor) {
      layoutObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      ancestor = ancestor.parentElement;
    }
    document.fonts?.addEventListener("loadingdone", scheduleUpdate);
    refreshViewport();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      layoutObserver.disconnect();
      document.fonts?.removeEventListener("loadingdone", scheduleUpdate);
      scrollParent?.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [updateViewport]);

  const heightIndex = useMemo(() => {
    return new HeightIndex(messages.length, VIRTUALIZED_MESSAGE_ESTIMATE_PX, MESSAGE_LIST_GAP_PX);
  }, [messages]);

  useEffect(() => {
    updateViewport();
  }, [messages, updateViewport]);

  useEffect(() => {
    return () => {
      if (pendingMeasureFrameRef.current) cancelAnimationFrame(pendingMeasureFrameRef.current);
      pendingMeasureFrameRef.current = 0;
    };
  }, []);

  const measureItem = useCallback(
    (index: number, height: number) => {
      if (!heightIndex.setHeight(index, height)) return;
      // Every row mounting in one frame would otherwise commit its own render.
      if (pendingMeasureFrameRef.current) return;
      pendingMeasureFrameRef.current = requestAnimationFrame(() => {
        pendingMeasureFrameRef.current = 0;
        setMeasurementVersion((version) => version + 1);
      });
    },
    [heightIndex],
  );

  const virtualItems = useMemo(
    () => {
      if (messages.length === 0) return [];
      void measurementVersion;

      const localStart = Math.max(0, viewport.scrollTop - viewport.listTop);
      const localEnd = localStart + viewport.height;
      const startIndex = Math.max(
        0,
        heightIndex.firstEndAfter(localStart) - VIRTUALIZED_MESSAGE_OVERSCAN,
      );
      const endIndex = Math.min(
        messages.length,
        heightIndex.firstStartAfter(localEnd) + VIRTUALIZED_MESSAGE_OVERSCAN,
      );

      const items: Array<{ index: number; start: number }> = [];
      for (let index = startIndex; index < endIndex; index += 1) {
        items.push({ index, start: heightIndex.startAt(index) });
      }

      const forcedIndex = forcedItem?.heightIndex === heightIndex ? forcedItem.index : null;
      if (forcedIndex != null && forcedIndex >= 0 && forcedIndex < messages.length) {
        if (!items.some((item) => item.index === forcedIndex)) {
          items.push({ index: forcedIndex, start: heightIndex.startAt(forcedIndex) });
          items.sort((a, b) => a.start - b.start);
        }
      }

      return items;
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, forcedItem, heightIndex, measurementVersion, messages.length, viewport],
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      if (typeof window === "undefined") return;
      if (index < 0 || index >= messages.length) return;

      setForcedItem({ heightIndex, index });
      const node = containerRef.current;
      const scrollParent = node ? findScrollParent(node) : (scrollParentRef.current ?? window);
      scrollParentRef.current = scrollParent;
      const listTop = node ? getElementTop(scrollParent, node) : 0;
      const nextTop = Math.max(0, listTop + heightIndex.startAt(index) - 24);
      scrollParentTo(scrollParent, nextTop);
      const nextViewport = {
        scrollTop: nextTop,
        height: getViewportHeight(scrollParent),
        listTop,
      };
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
    },
    [heightIndex, messages.length],
  );

  useEffect(() => {
    apiRef.current = { scrollToIndex };
    return () => {
      if (apiRef.current?.scrollToIndex === scrollToIndex) apiRef.current = null;
    };
  }, [apiRef, scrollToIndex]);

  return (
    <TimelineAnchorRegistryProvider registry={anchorRegistry}>
      <div
        ref={containerRef}
        className="relative min-w-0"
        style={{ height: Math.max(1, heightIndex.totalSize) }}
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
                messageIndex={item.index}
                msg={item.msg}
                blocks={item.blocks}
                formatTokens={formatTokens}
                sessionAgentKey={sessionAgentKey}
                agent={agent}
                baseDirectory={baseDirectory}
                highlightQuery={highlightQuery}
                childSessionById={childSessionById}
              />
            </VirtualizedMessageRow>
          );
        })}
      </div>
    </TimelineAnchorRegistryProvider>
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
  useLocale();

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
