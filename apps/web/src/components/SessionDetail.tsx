/* eslint-disable react/no-array-index-key */
import {
  Bot,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FilePenLine,
  FileSearch,
  FileText,
  Funnel,
  Lightbulb,
  LoaderCircle,
  MessageCircleX,
  Minus,
  NotebookPen,
  X,
  UserRound,
  XCircle,
} from "lucide-react";
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
import type { Message, MessagePart, SessionData } from "../lib/api";
import { InteractiveReceipt } from "./InteractiveReceipt";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import { extractMessageText, type MessageBlock } from "./session-detail/blocks";
import { isCodexTurnAbortedMessage } from "./session-detail/codex-abort";
import { buildCodexPlanDisplay } from "./session-detail/codex-plan";
import {
  buildSessionDetailToc,
  filterSessionMessages,
  type FilteredSessionMessage,
  type SessionDetailToc,
  type TocFilterId,
} from "./session-detail/toc";
import { buildMessageDisplayModels } from "./session-detail/display-model";
import { escapeRegExp } from "./session-detail/utils";
import {
  type FileChangeKind,
  type FileChangeSummary,
  type FileChangeSummaryItem,
  buildFileChangeSummary,
  buildFileChangeSummaryFromActivity,
} from "./session-detail/file-change";
import { formatTrackedPath, getDisplayTextWithRelativePaths } from "./session-detail/path-extract";
import {
  type ToolStatus,
  formatMessageTime,
  formatTokens,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./session-detail/tool-strategy";
import { ToolOutputRenderer } from "./tool-output/ToolOutputRenderer";

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

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; className: string; icon: typeof LoaderCircle }
> = {
  completed: {
    label: "Success",
    className:
      "border-[var(--console-success-border)] bg-[var(--console-success-bg)] text-[var(--console-success)]",
    icon: CheckCircle2,
  },
  error: {
    label: "Failed",
    className:
      "border-[var(--console-error-border)] bg-[var(--console-error-bg)] text-[var(--console-error)]",
    icon: XCircle,
  },
  running: {
    label: "Running",
    className:
      "border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] text-[var(--console-warning)]",
    icon: LoaderCircle,
  },
};

const MESSAGE_LIST_GAP_PX = 32;
const VIRTUALIZED_MESSAGE_THRESHOLD = 80;
const VIRTUALIZED_MESSAGE_ESTIMATE_PX = 280;
const VIRTUALIZED_MESSAGE_OVERSCAN = 6;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function buildHighlightPattern(query?: string): RegExp | null {
  const normalized = query?.trim();
  if (!normalized) return null;
  const terms = Array.from(
    new Set(
      (normalized.match(/"[^"]+"|\S+/g) ?? [])
        .map((term) => term.replace(/^"|"$/g, "").trim())
        .filter(Boolean)
        .filter((term) => !/^OR$/i.test(term)),
    ),
  );
  if (terms.length === 0) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
}

function renderHighlightedText(text: string, query?: string) {
  const pattern = buildHighlightPattern(query);
  if (!pattern) return text;

  const parts = text.split(pattern);
  return parts.map((part, index) =>
    part.match(pattern) ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

function MessageMarkdown({ text, highlightQuery }: { text: string; highlightQuery?: string }) {
  return <MarkdownContent text={text} highlightQuery={highlightQuery} />;
}

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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setReady(true));
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [session.id]);

  if (!ready) return <aside className="hidden xl:block" aria-hidden="true" />;

  return (
    <RenderProfiler id="InteractiveReceipt">
      <InteractiveReceipt key={session.id} session={session} toc={toc} />
    </RenderProfiler>
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

  useEffect(() => {
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
      <div className="grid gap-6 min-[1025px]:grid-cols-[240px_minmax(0,1fr)] min-[1025px]:items-start min-[1280px]:grid-cols-[220px_minmax(0,1fr)_320px]">
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
        <DeferredInteractiveReceipt session={session} toc={toc} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionToc
// ---------------------------------------------------------------------------

const TOC_META: Array<{ id: TocFilterId; label: string }> = [
  { id: "user", label: "User" },
  { id: "agent_message", label: "Agent Responses" },
  { id: "thinking", label: "Thinking" },
  { id: "plan", label: "Plans" },
  { id: "tools_all", label: "Tools" },
];

function getTocToolIds(toc: SessionDetailToc) {
  return toc.tools.map((tool) => tool.id);
}

function toggleTocFilter(currentFilters: Set<string>, filterId: string, toc: SessionDetailToc) {
  const next = new Set(currentFilters);
  const toolIds = getTocToolIds(toc);

  if (filterId === "tools_all") {
    const selectedToolCount = toolIds.filter((id) => next.has(id)).length;
    const shouldSelectAllTools = selectedToolCount < toolIds.length;
    if (shouldSelectAllTools) {
      next.add("tools_all");
      for (const toolId of toolIds) next.add(toolId);
    } else {
      next.delete("tools_all");
      for (const toolId of toolIds) next.delete(toolId);
    }
    return next;
  }

  if (filterId.startsWith("tool:")) {
    if (next.has(filterId)) {
      next.delete(filterId);
    } else {
      next.add(filterId);
    }

    const selectedToolCount = toolIds.filter((id) => next.has(id)).length;
    if (selectedToolCount === toolIds.length) {
      next.add("tools_all");
    } else {
      next.delete("tools_all");
    }
    return next;
  }

  if (next.has(filterId)) {
    next.delete(filterId);
  } else {
    next.add(filterId);
  }
  return next;
}

function getFileTrackerItemCount(summary: FileChangeSummary) {
  return summary.read.length + summary.edit.length + summary.write.length + summary.delete.length;
}

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

function TocCheckbox({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className="relative mt-0.5 size-3.5 shrink-0">
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={checked}
        aria-checked={indeterminate ? "mixed" : checked}
        data-indeterminate={indeterminate ? "true" : undefined}
        onChange={onChange}
        className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className={`flex size-3.5 items-center justify-center rounded border ${
          checked || indeterminate
            ? "border-[var(--console-accent-strong)] bg-[var(--console-accent-strong)] text-white"
            : "border-[var(--console-border-strong)] bg-white text-transparent"
        }`}
      >
        {indeterminate ? (
          <Minus className="size-2.5 stroke-[3]" />
        ) : checked ? (
          <Check className="size-2.5 stroke-[3]" />
        ) : null}
      </span>
    </span>
  );
}

function SessionToc({
  toc,
  fileChangeSummary,
  baseDirectory,
  selectedFilters,
  onToggle,
  onJumpToAnchor,
}: {
  toc: SessionDetailToc;
  fileChangeSummary: FileChangeSummary;
  baseDirectory: string;
  selectedFilters: Set<string>;
  onToggle: (filterId: string) => void;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  return (
    <aside className="console-scrollbar hidden min-[1025px]:sticky min-[1025px]:top-4 min-[1025px]:block min-[1025px]:max-h-[calc(100dvh-14rem)] min-[1025px]:overflow-y-auto min-[1025px]:overscroll-contain">
      <div className="space-y-4">
        <SessionTocFilterPanel toc={toc} selectedFilters={selectedFilters} onToggle={onToggle} />
        <FileChangeTracker
          summary={fileChangeSummary}
          baseDirectory={baseDirectory}
          onJumpToAnchor={onJumpToAnchor}
        />
      </div>
    </aside>
  );
}

function SessionTocFilterPanel({
  toc,
  selectedFilters,
  onToggle,
}: {
  toc: SessionDetailToc;
  selectedFilters: Set<string>;
  onToggle: (filterId: string) => void;
}) {
  const toolIds = getTocToolIds(toc);
  const selectedToolCount = toolIds.filter((id) => selectedFilters.has(id)).length;
  const allToolsSelected = toolIds.length > 0 && selectedToolCount === toolIds.length;
  const someToolsSelected = selectedToolCount > 0 && selectedToolCount < toolIds.length;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
        <Funnel className="size-3.5 text-[var(--console-accent)]" />
        <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          Session TOC
        </span>
      </div>
      <div className="space-y-1 p-3">
        {TOC_META.filter(({ id }) => toc.counts[id] > 0).map(({ id, label }) => (
          <label
            key={id}
            className="flex cursor-pointer items-start gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-[var(--console-surface-muted)]"
          >
            <TocCheckbox
              checked={id === "tools_all" ? allToolsSelected : selectedFilters.has(id)}
              indeterminate={id === "tools_all" ? someToolsSelected : false}
              onChange={() => onToggle(id)}
            />
            <span className="console-mono min-w-0 flex-1 break-all text-xs leading-relaxed text-[var(--console-text)]">
              {label}
            </span>
            <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
              {toc.counts[id]}
            </span>
          </label>
        ))}
        {toc.tools.length > 0 ? (
          <div className="space-y-1 border-t border-[var(--console-border)] pt-2">
            {toc.tools.map((tool) => (
              <label
                key={tool.id}
                className="flex cursor-pointer items-start gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <TocCheckbox
                  checked={selectedFilters.has(tool.id)}
                  onChange={() => onToggle(tool.id)}
                />
                <span className="console-mono min-w-0 flex-1 break-all text-xs leading-relaxed text-[var(--console-muted)]">
                  {tool.label}
                </span>
                <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                  {tool.count}
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FileChangeTracker({
  summary,
  baseDirectory,
  onJumpToAnchor,
}: {
  summary: FileChangeSummary;
  baseDirectory: string;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  const sections = [
    { key: "read" as const, label: "Read", Icon: FileSearch, items: summary.read },
    { key: "edit" as const, label: "Edit", Icon: FilePenLine, items: summary.edit },
    { key: "write" as const, label: "Write", Icon: NotebookPen, items: summary.write },
    { key: "delete" as const, label: "Delete", Icon: XCircle, items: summary.delete },
  ].filter((section) => section.items.length > 0) satisfies Array<{
    key: FileChangeKind;
    label: string;
    Icon: typeof LoaderCircle;
    items: FileChangeSummaryItem[];
  }>;

  if (sections.length === 0) return null;

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 border-b border-[var(--console-border)] px-4 py-3">
        <FileText className="size-3.5 text-[var(--console-accent)]" />
        <span className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
          File Tracker
        </span>
      </div>
      <div className="space-y-3 p-3">
        {sections.map(({ key, label, Icon, items }) => (
          <FileTrackerSection
            key={key}
            label={label}
            Icon={Icon}
            items={items}
            baseDirectory={baseDirectory}
            onJumpToAnchor={onJumpToAnchor}
          />
        ))}
      </div>
    </div>
  );
}

function FileTrackerSection({
  label,
  Icon,
  items,
  baseDirectory,
  onJumpToAnchor,
}: {
  label: string;
  Icon: typeof LoaderCircle;
  items: FileChangeSummaryItem[];
  baseDirectory: string;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-[#fafafa]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--console-surface-muted)]"
      >
        <Icon className="size-3.5 shrink-0 text-[var(--console-accent)]" />
        <span className="console-mono min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--console-muted)]">
          {label}
        </span>
        <span className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]">
          {items.length}
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 shrink-0 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <div className="space-y-1 border-t border-[var(--console-border)] p-2">
          {items.map((item) => (
            <FileTrackerItem
              key={`${item.path}:${item.latestAnchorId || item.latestTime}`}
              item={item}
              baseDirectory={baseDirectory}
              onJumpToAnchor={onJumpToAnchor}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileTrackerItem({
  item,
  baseDirectory,
  onJumpToAnchor,
}: {
  item: FileChangeSummaryItem;
  baseDirectory: string;
  onJumpToAnchor: (anchorId: string) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);

  function jumpToIndex(nextIndex: number) {
    const total = item.anchors.length;
    if (total === 0) return;
    const normalizedIndex = ((nextIndex % total) + total) % total;
    setCurrentIndex(normalizedIndex);
    const anchor = item.anchors[normalizedIndex];
    if (anchor) {
      onJumpToAnchor(anchor.anchorId);
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-sm px-2 py-2 transition-colors hover:bg-[var(--console-surface-muted)]">
      <button
        type="button"
        title={item.path}
        onClick={() => jumpToIndex(currentIndex)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="console-mono block break-all text-xs text-[var(--console-text)]">
          {formatTrackedPath(item.path, baseDirectory)}
        </span>
      </button>
      {item.anchors.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Previous ${item.path}`}
            onClick={() => jumpToIndex(currentIndex - 1)}
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            <ChevronUp className="size-3" />
          </button>
          <span className="console-mono text-[10px] text-[var(--console-muted)]">
            {currentIndex + 1}/{item.anchors.length}
          </span>
          <button
            type="button"
            aria-label={`Next ${item.path}`}
            onClick={() => jumpToIndex(currentIndex + 1)}
            className="rounded-sm border border-[var(--console-border)] p-1 text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Jump to tool call"
          onClick={() => jumpToIndex(0)}
          className="console-mono shrink-0 text-[10px] text-[var(--console-muted)]"
        >
          {item.count}
        </button>
      )}
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

// ---------------------------------------------------------------------------
// MessageItem
// ---------------------------------------------------------------------------

function MessageItem({
  msg,
  blocks,
  toolAnchorIds,
  formatTokens: fmtTokens,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  msg: Message;
  blocks: MessageBlock[];
  toolAnchorIds: Map<MessagePart, string>;
  formatTokens: (n: number) => string;
  sessionAgentKey: string;
  baseDirectory: string;
  highlightQuery?: string;
}) {
  const isUser = msg.role === "user";
  const isAbortMessage = isCodexTurnAbortedMessage(msg, sessionAgentKey);

  const getAgentAvatar = () => {
    const agentKey = sessionAgentKey.toLowerCase();
    const agentName = ModelConfig.getAgentName(agentKey);
    const agentIcon = ModelConfig.agents[agentKey]?.icon;
    return (
      <>
        {agentIcon ? (
          <img src={agentIcon} alt={agentName} className="size-4 rounded-sm object-cover" />
        ) : (
          <Bot className="size-4 text-[var(--console-muted)]" />
        )}
      </>
    );
  };

  const modeLabel = msg.mode ? msg.mode.toUpperCase() : null;
  const modelLabel = msg.model || null;
  const roleLabel = getAssistantDisplayLabel(msg);
  const time = formatMessageTime(msg.time_created);

  return (
    <article className="w-full border-l-2 border-[var(--console-thread)] pl-4 pr-3 md:pr-5">
      <div className="flex gap-4">
        <div className="shrink-0 pt-1">
          <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
            {isUser ? (
              <UserRound className="size-4 text-[var(--console-muted)]" />
            ) : (
              getAgentAvatar()
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="console-mono text-sm font-bold tracking-wide text-[var(--console-text)]">
              {roleLabel}
            </span>
            <time className="console-mono text-xs text-[var(--console-muted)]">{time}</time>
            {modeLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modeLabel}
              </span>
            )}
            {modelLabel && (
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
                {modelLabel}
              </span>
            )}
          </div>

          {isAbortMessage ? (
            <AbortToolItem />
          ) : (
            blocks.map((block, index) => {
              if (block.type === "reasoning") {
                return (
                  <ReasoningSection
                    key={index}
                    parts={block.parts}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              if (block.type === "plan") {
                return (
                  <PlansSection key={index} parts={block.parts} highlightQuery={highlightQuery} />
                );
              }
              if (block.type === "tool") {
                return (
                  <ToolsSection
                    key={index}
                    parts={block.parts}
                    toolAnchorIds={toolAnchorIds}
                    sessionAgentKey={sessionAgentKey}
                    baseDirectory={baseDirectory}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              return (
                <div
                  key={index}
                  className="rounded-sm border border-[var(--console-border)] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                >
                  <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
                    {block.parts.map((part, partIndex) => (
                      <MessageMarkdown
                        key={partIndex}
                        text={extractMessageText(part.text)}
                        highlightQuery={highlightQuery}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}

          {!isUser && (msg.tokens || msg.cost) && (
            <div className="flex flex-wrap gap-2">
              {msg.tokens?.input ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  INPUT {fmtTokens(msg.tokens.input)}
                </span>
              ) : null}
              {msg.tokens?.output ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  OUTPUT {fmtTokens(msg.tokens.output)}
                </span>
              ) : null}
              {msg.tokens?.reasoning ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  REASONING {fmtTokens(msg.tokens.reasoning)}
                </span>
              ) : null}
              {msg.cost ? (
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                  {msg.cost_source === "estimated" ? "EST COST" : "COST"} ${msg.cost.toFixed(4)}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AbortToolItem() {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-full rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] md:w-[560px]">
          <div className="flex items-start gap-2">
            <MessageCircleX className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                abort
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasoningSection({
  parts,
  highlightQuery,
}: {
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fullText = parts
    .map((p) => extractMessageText(p.text))
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className="overflow-hidden rounded-sm border border-[var(--console-thinking-border)] bg-[var(--console-thinking-bg)]">
      <div
        className="flex cursor-pointer items-center justify-between bg-[var(--console-surface-muted)] px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="console-mono flex items-center gap-2 text-xs font-medium text-[var(--console-muted)]">
          <Lightbulb className="size-3.5" />
          Thinking
        </span>
        <span className="text-[var(--console-muted)]">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-dashed border-[var(--console-thinking-border)] px-4 py-3">
          <div className="console-mono whitespace-pre-wrap text-xs leading-relaxed text-[var(--console-muted)]">
            {renderHighlightedText(fullText, highlightQuery)}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolsSection({
  parts,
  toolAnchorIds,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  parts: MessagePart[];
  toolAnchorIds: Map<MessagePart, string>;
  sessionAgentKey: string;
  baseDirectory: string;
  highlightQuery?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {parts.map((tool, i) => (
          <ToolItem
            key={i}
            tool={tool}
            anchorId={toolAnchorIds.get(tool)}
            sessionAgentKey={sessionAgentKey}
            baseDirectory={baseDirectory}
            highlightQuery={highlightQuery}
          />
        ))}
      </div>
    </div>
  );
}

function PlansSection({
  parts,
  highlightQuery,
}: {
  parts: MessagePart[];
  highlightQuery?: string;
}) {
  return (
    <div className="space-y-2">
      {parts.map((plan, i) => (
        <PlanItem key={i} part={plan} highlightQuery={highlightQuery} />
      ))}
    </div>
  );
}

function PlanItem({ part, highlightQuery }: { part: MessagePart; highlightQuery?: string }) {
  const [expanded, setExpanded] = useState(false);
  const display = buildCodexPlanDisplay(part);
  const statusMeta =
    display.approvalStatus === "fail" ? TOOL_STATUS_META.error : TOOL_STATUS_META.completed;
  const StatusIcon = statusMeta.icon;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full md:w-[560px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            display.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {display.expandable ? (
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => setExpanded(!expanded)}
            >
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {display.title}
                </span>
              </span>
            </div>
          )}
        </div>
        <span
          className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusMeta.className}`}
        >
          <StatusIcon className="size-3" />
          {statusMeta.label}
        </span>
      </div>

      {display.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">
              {display.contentLabel}
            </span>
          </div>
          <div className="p-4">
            <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
              <MessageMarkdown text={display.contentMarkdown} highlightQuery={highlightQuery} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolItem({
  tool,
  anchorId,
  sessionAgentKey,
  baseDirectory,
  highlightQuery,
}: {
  tool: MessagePart;
  anchorId?: string;
  sessionAgentKey: string;
  baseDirectory?: string;
  highlightQuery?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const state = normalizeToolState(tool);
  const strategy = getToolDisplayStrategy(sessionAgentKey, tool, state, baseDirectory);
  const inputPreviewText = getDisplayTextWithRelativePaths(state.inputText || "{}", baseDirectory);
  const statusMeta = TOOL_STATUS_META[state.status];
  const StatusIcon = statusMeta.icon;
  const ToolIcon = strategy.Icon;

  return (
    <div id={anchorId} className="scroll-mt-6 space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={`w-full md:w-[560px] rounded-sm border border-[var(--console-border-strong)] bg-white px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(15,23,42,0.05)] ${
            strategy.expandable ? "transition-colors hover:bg-[var(--console-surface-muted)]" : ""
          }`}
        >
          {strategy.expandable ? (
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => setExpanded(!expanded)}
            >
              <ToolIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--console-muted)]">
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <ToolIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--console-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="console-mono block text-xs font-semibold text-[var(--console-text)]">
                  {strategy.title}
                </span>
                {strategy.secondaryText ? (
                  <span className="console-mono mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--console-muted)]">
                    {renderHighlightedText(strategy.secondaryText, highlightQuery)}
                  </span>
                ) : null}
              </span>
            </div>
          )}
        </div>
        <span
          className={`console-mono inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusMeta.className}`}
        >
          <StatusIcon className={`size-3 ${state.status === "running" ? "animate-spin" : ""}`} />
          {statusMeta.label}
        </span>
      </div>

      {strategy.expandable && expanded ? (
        <div className="overflow-hidden rounded-sm border border-[var(--console-border)] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="border-b border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5">
            <span className="console-mono text-xs text-[var(--console-muted)]">Output</span>
          </div>
          <div className="space-y-3 p-3">
            {strategy.details.length > 0 ? (
              <div className="rounded-sm border border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
                <div className="space-y-2">
                  {strategy.details.map((detail) => (
                    <div
                      key={`${detail.label}:${detail.value}`}
                      className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3"
                    >
                      <span className="console-mono shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--console-muted)] md:w-24">
                        {detail.label}
                      </span>
                      <span className="console-mono whitespace-pre-wrap break-all text-xs leading-relaxed text-[var(--console-text)]">
                        {renderHighlightedText(detail.value, highlightQuery)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <ToolOutputRenderer outputContent={strategy.outputContent} />
          </div>
          {strategy.showInputPreview ? (
            <div className="border-t border-[var(--console-border)] bg-[#fafafa] px-3 py-2">
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                Input Preview
              </span>
              <pre className="console-mono mt-1 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-all text-xs leading-relaxed text-[var(--console-muted)]">
                {renderHighlightedText(inputPreviewText, highlightQuery)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
