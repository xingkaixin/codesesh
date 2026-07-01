/* eslint-disable react/no-array-index-key */
import { ChevronDown, ChevronUp, FileText, Funnel, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelConfig } from "../config";
import type { SessionData } from "../lib/api";
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
import { normalizeMessagesForDisplay } from "./session-detail/tool-strategy";
import {
  MessageList,
  type MessageListHandle,
  VIRTUALIZED_MESSAGE_THRESHOLD,
} from "./session-detail/message-list";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionData;
  highlightQuery?: string;
}

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
