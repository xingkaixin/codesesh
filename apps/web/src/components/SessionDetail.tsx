/* eslint-disable react/no-array-index-key */
import { ChevronDown, ChevronUp, FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelConfig } from "../config";
import type { SessionData } from "../lib/api";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import { buildSessionDetailToc, filterSessionMessages } from "./session-detail/toc";
import { buildMessageDisplayModels } from "./session-detail/display-model";
import {
  buildFileChangeSummary,
  buildFileChangeSummaryFromActivity,
} from "./session-detail/file-change";
import { SessionToc, toggleTocFilter } from "./session-detail/session-toc";
import { normalizeMessagesForDisplay } from "./session-detail/tool-strategy";
import {
  MessageList,
  type MessageListHandle,
  VIRTUALIZED_MESSAGE_THRESHOLD,
} from "./session-detail/message-list";
import {
  DeferredInteractiveReceipt,
  SessionDetailAuxControls,
  SessionDetailAuxOverlay,
} from "./session-detail/session-detail-aux";

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
