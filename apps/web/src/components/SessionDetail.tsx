/* eslint-disable react/no-array-index-key */
import { ChevronDown, ChevronUp, FileText, Funnel, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ModelConfig } from "../config";
import type { MessagePart, SessionData } from "../lib/api";
import { InteractiveReceipt } from "./InteractiveReceipt";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import {
  buildSessionDetailToc,
  filterSessionMessages,
  type FilteredSessionMessage,
  type SessionDetailToc,
} from "./session-detail/toc";
import { buildMessageDisplayModels } from "./session-detail/display-model";
import {
  type FileChangeSummary,
  buildFileChangeSummary,
  buildFileChangeSummaryFromActivity,
} from "./session-detail/file-change";
import { FileChangeTracker, getFileTrackerItemCount } from "./session-detail/file-change-tracker";
import { SessionToc, SessionTocFilterPanel, toggleTocFilter } from "./session-detail/session-toc";
import { MessageItem } from "./session-detail/message-rendering";
import { formatTokens, normalizeMessagesForDisplay } from "./session-detail/tool-strategy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionData;
  highlightQuery?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGE_LIST_GAP_PX = 32;
const VIRTUALIZED_MESSAGE_THRESHOLD = 80;
const VIRTUALIZED_MESSAGE_ESTIMATE_PX = 280;
const VIRTUALIZED_MESSAGE_OVERSCAN = 6;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function scrollToToolAnchor(anchorId: string, prepareAnchor?: () => void) {
  if (typeof document === "undefined") return;
  let element = document.getElementById(anchorId);
  if (!element && prepareAnchor) {
    prepareAnchor();
    let attempts = 0;
    const retryScroll = () => {
      element = document.getElementById(anchorId);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 8) requestAnimationFrame(retryScroll);
    };
    requestAnimationFrame(retryScroll);
    return;
  }
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

function measureSessionDetailWork<T>(id: string, compute: () => T): T {
  if (!isRenderProfilerEnabled()) return compute();

  const startedAt = performance.now();
  const value = compute();
  const endedAt = performance.now();
  recordRenderProfileEntry({
    id,
    source: "custom-timing",
    phase: "measure",
    actualDuration: Math.round((endedAt - startedAt) * 100) / 100,
    baseDuration: 0,
    startTime: startedAt,
    commitTime: endedAt,
  });
  return value;
}

function DeferredInteractiveReceipt({
  session,
  toc,
}: {
  session: SessionData;
  toc: SessionDetailToc;
}) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [session.id]);

  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }

    setReady(false);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setReady(true));
    });
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnSmallViewport = () => {
      if (!desktopQuery.matches) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    desktopQuery.addEventListener("change", closeOnSmallViewport);
    closeOnSmallViewport();

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      desktopQuery.removeEventListener("change", closeOnSmallViewport);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Open session receipt"
        onClick={() => setOpen(true)}
        className="console-mono fixed right-0 top-1/2 z-40 hidden h-32 w-10 -translate-y-1/2 items-center justify-center rounded-l-sm border border-r-0 border-[var(--console-border)] bg-white text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--console-text)] shadow-[-2px_4px_14px_rgba(15,23,42,0.14)] transition-colors hover:bg-[var(--console-surface-muted)] min-[1025px]:flex"
      >
        <span className="[writing-mode:vertical-rl]">Receipt</span>
      </button>
      {open ? (
        <div className="fixed inset-0 z-[60] hidden min-[1025px]:block">
          <button
            type="button"
            aria-label="Close session receipt"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/20"
          />
          <aside className="absolute right-0 top-0 z-10 h-full w-[min(92vw,430px)] border-l border-[var(--console-border)] bg-[var(--console-bg)] p-4 shadow-[-12px_0_32px_rgba(15,23,42,0.18)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
                Session Receipt
              </span>
              <button
                type="button"
                aria-label="Close session receipt"
                onClick={() => setOpen(false)}
                className="rounded-sm border border-[var(--console-border)] bg-white p-2 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>
            {ready ? (
              <RenderProfiler id="InteractiveReceipt">
                <InteractiveReceipt key={session.id} session={session} toc={toc} />
              </RenderProfiler>
            ) : (
              <div className="h-[calc(100dvh-5.5rem)] min-h-[420px] rounded-sm border border-[var(--console-border)] bg-white" />
            )}
          </aside>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Message list virtualization
// ---------------------------------------------------------------------------

interface MessageListHandle {
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

function MessageList({
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

// ---------------------------------------------------------------------------
// SessionDetail (main export)
// ---------------------------------------------------------------------------

export function SessionDetail({ session, highlightQuery }: SessionDetailProps) {
  const sessionSlug = session.slug || "";
  const sessionAgentKey =
    sessionSlug.split("/")[0] || ModelConfig.getDefaultAgentKey() || "claudecode";
  const normalizedMessages = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:normalizeMessages", () =>
        normalizeMessagesForDisplay(session.messages, sessionAgentKey),
      ),
    [session.messages, sessionAgentKey],
  );
  const messageModels = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:buildMessageDisplayModels", () =>
        buildMessageDisplayModels(normalizedMessages),
      ),
    [normalizedMessages],
  );
  const {
    toolAnchorIds,
    anchorMessageIndexes,
    summary: localFileChangeSummary,
  } = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:buildFileChangeSummary", () =>
        buildFileChangeSummary(messageModels),
      ),
    [messageModels],
  );
  const toc = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:buildSessionDetailToc", () =>
        buildSessionDetailToc(messageModels),
      ),
    [messageModels],
  );
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(() => new Set(toc.filterIds));
  const [openAuxPanel, setOpenAuxPanel] = useState<"toc" | "files" | null>(null);
  const tocSignature = useMemo(() => [...toc.filterIds].toSorted().join("|"), [toc.filterIds]);
  const selectedFilterSignature = useMemo(
    () => [...selectedFilters].toSorted().join("|"),
    [selectedFilters],
  );
  const filteredMessages = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:filterSessionMessages", () =>
        filterSessionMessages(messageModels, selectedFilters),
      ),
    [messageModels, selectedFilters],
  );
  const virtualListRef = useRef<MessageListHandle | null>(null);
  const anchorListIndexes = useMemo(() => {
    return measureSessionDetailWork("SessionDetail:buildAnchorListIndexes", () => {
      const indexes = new Map<number, number>();
      filteredMessages.forEach((item, listIndex) => {
        indexes.set(item.index, listIndex);
      });
      return indexes;
    });
  }, [filteredMessages]);
  const fileChangeSummary = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:mergeFileActivitySummary", () =>
        buildFileChangeSummaryFromActivity(session.file_activity, localFileChangeSummary),
      ),
    [session.file_activity, localFileChangeSummary],
  );
  const handleJumpToAnchor = useCallback(
    (anchorId: string) => {
      const messageIndex = anchorMessageIndexes.get(anchorId);
      const listIndex = messageIndex == null ? undefined : anchorListIndexes.get(messageIndex);
      scrollToToolAnchor(anchorId, () => {
        if (listIndex != null) virtualListRef.current?.scrollToIndex(listIndex);
      });
    },
    [anchorListIndexes, anchorMessageIndexes],
  );

  useEffect(() => {
    setSelectedFilters(new Set(toc.filterIds));
  }, [tocSignature, toc.filterIds]);

  if (messageModels.length === 0) {
    return (
      <div
        data-testid="session-detail"
        className="mx-auto max-w-4xl rounded-sm border border-[var(--console-border)] bg-white p-6 text-sm text-[var(--console-muted)]"
      >
        当前会话暂无可展示的消息内容。
      </div>
    );
  }

  return (
    <div
      data-testid="session-detail"
      className="mx-auto w-full max-w-[1440px] space-y-8 px-2 md:px-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <SessionSummarySection
        summary={typeof session.summary_files === "string" ? session.summary_files : undefined}
      />
      <div className="grid gap-6 min-[1025px]:grid-cols-[240px_minmax(0,1fr)] min-[1025px]:items-start min-[1280px]:grid-cols-[220px_minmax(0,1fr)]">
        <SessionDetailAuxControls
          toc={toc}
          fileChangeSummary={fileChangeSummary}
          onOpen={setOpenAuxPanel}
        />
        <SessionDetailAuxOverlay
          openPanel={openAuxPanel}
          toc={toc}
          fileChangeSummary={fileChangeSummary}
          baseDirectory={session.directory}
          selectedFilters={selectedFilters}
          onClose={() => setOpenAuxPanel(null)}
          onToggle={(filterId) =>
            setSelectedFilters((current) => {
              return toggleTocFilter(current, filterId, toc);
            })
          }
          onJumpToAnchor={(anchorId) => {
            setOpenAuxPanel(null);
            handleJumpToAnchor(anchorId);
          }}
        />
        <SessionToc
          toc={toc}
          fileChangeSummary={fileChangeSummary}
          baseDirectory={session.directory}
          selectedFilters={selectedFilters}
          onToggle={(filterId) =>
            setSelectedFilters((current) => {
              return toggleTocFilter(current, filterId, toc);
            })
          }
          onJumpToAnchor={handleJumpToAnchor}
        />
        <div className="flex min-w-0 flex-col gap-8">
          {filteredMessages.length > 0 ? (
            <RenderProfiler
              id="MessageList"
              detail={{
                messages: filteredMessages.length,
                virtualized: filteredMessages.length > VIRTUALIZED_MESSAGE_THRESHOLD,
              }}
            >
              <MessageList
                key={`${session.id}:${selectedFilterSignature}`}
                messages={filteredMessages}
                toolAnchorIds={toolAnchorIds}
                sessionAgentKey={sessionAgentKey}
                baseDirectory={session.directory}
                highlightQuery={highlightQuery}
                apiRef={virtualListRef}
              />
            </RenderProfiler>
          ) : (
            <div className="rounded-sm border border-[var(--console-border)] bg-white p-6 text-sm text-[var(--console-muted)]">
              当前筛选条件下暂无可展示的消息内容。
            </div>
          )}
        </div>
      </div>
      <DeferredInteractiveReceipt session={session} toc={toc} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionDetailAuxControls({
  toc,
  fileChangeSummary,
  onOpen,
}: {
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  onOpen: (panel: "toc" | "files") => void;
}) {
  const fileCount = getFileTrackerItemCount(fileChangeSummary);

  return (
    <div className="flex flex-wrap gap-2 min-[1025px]:hidden">
      <button
        type="button"
        onClick={() => onOpen("toc")}
        className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <Funnel className="size-3.5 text-[var(--console-accent)]" />
        TOC
        <span className="text-[var(--console-muted)]">{toc.counts.tools_all}</span>
      </button>
      {fileCount > 0 ? (
        <button
          type="button"
          onClick={() => onOpen("files")}
          className="console-mono inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--console-text)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[var(--console-surface-muted)]"
        >
          <FileText className="size-3.5 text-[var(--console-accent)]" />
          Files
          <span className="text-[var(--console-muted)]">{fileCount}</span>
        </button>
      ) : null}
    </div>
  );
}

function SessionDetailAuxOverlay({
  openPanel,
  toc,
  fileChangeSummary,
  baseDirectory,
  selectedFilters,
  onClose,
  onToggle,
  onJumpToAnchor,
}: {
  openPanel: "toc" | "files" | null;
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  selectedFilters: Set<string>;
  onClose: () => void;
  onToggle: (filterId: string) => void;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  useEffect(() => {
    if (!openPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnDesktop = () => {
      if (desktopQuery.matches) onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    desktopQuery.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      desktopQuery.removeEventListener("change", closeOnDesktop);
    };
  }, [onClose, openPanel]);

  if (!openPanel) return null;

  return (
    <div className="fixed inset-0 z-50 min-[1025px]:hidden">
      <button
        type="button"
        aria-label="Close navigation panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside className="console-scrollbar absolute right-0 top-0 h-full w-[min(90vw,380px)] overflow-y-auto border-l border-[var(--console-border)] bg-[var(--console-bg)] p-3 shadow-[-10px_0_30px_rgba(15,23,42,0.16)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
            {openPanel === "toc" ? "Session TOC" : "File Tracker"}
          </span>
          <button
            type="button"
            aria-label="Close navigation panel"
            onClick={onClose}
            className="rounded-sm border border-[var(--console-border)] bg-white p-2 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)]"
          >
            <X className="size-4" />
          </button>
        </div>
        {openPanel === "toc" ? (
          <SessionTocFilterPanel toc={toc} selectedFilters={selectedFilters} onToggle={onToggle} />
        ) : (
          <FileChangeTracker
            summary={fileChangeSummary}
            baseDirectory={baseDirectory}
            onJumpToAnchor={onJumpToAnchor}
          />
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionSummarySection
// ---------------------------------------------------------------------------

export function SessionSummarySection({
  summary,
  defaultExpanded = false,
}: {
  summary?: string;
  defaultExpanded?: boolean;
}) {
  const content = typeof summary === "string" ? summary.trim() : "";
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!content) return null;

  return (
    <section className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="console-mono inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          <FileText className="size-3.5 text-[var(--console-accent)]" />
          Session Summary
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown className="size-3.5 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <div className="border-t border-[var(--console-border)] px-4 py-4">
          <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
            <MarkdownContent text={content} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
