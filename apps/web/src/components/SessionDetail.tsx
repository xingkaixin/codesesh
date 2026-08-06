/* eslint-disable react/no-array-index-key */
import { ChevronDown, ChevronUp, FileText } from "./ui/icons";
import { useCallback, useMemo, useRef, useState } from "react";
import { findAgent, type AgentCatalog } from "../lib/agents";
import type { SessionDetail, SessionHead } from "../lib/api";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import { buildSessionDetailDisplayModel } from "./session-detail/display-model";
import { SessionFilterAside } from "./session-detail/filter-panel";
import { SessionFilterChips } from "./session-detail/filter-chips";
import { deriveHiddenCount, deriveHiddenTools } from "./session-detail/filter-state";
import { HiddenToolsFooter } from "./session-detail/hidden-tools-footer";
import { useSessionFilters } from "./session-detail/use-session-filters";
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
import { SessionMessageTimeline } from "./session-detail/session-message-timeline";
import {
  resolveReducedMotionScrollBehavior,
  type SessionAnchorScrollBehavior,
} from "./session-detail/scroll-behavior";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionDetail;
  agentCatalog: AgentCatalog;
  highlightQuery?: string;
  childSessions?: SessionHead[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function scrollToSessionAnchor({
  anchorId,
  behavior,
  prepareAnchor,
  isCurrent,
}: {
  anchorId: string;
  behavior: SessionAnchorScrollBehavior;
  prepareAnchor?: () => void;
  isCurrent: () => boolean;
}) {
  if (typeof document === "undefined") return;
  const scrollBehavior = resolveReducedMotionScrollBehavior(
    behavior,
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  let element = document.getElementById(anchorId);
  if (!element && prepareAnchor) {
    prepareAnchor();
    let attempts = 0;
    const retryScroll = () => {
      if (!isCurrent()) return;
      element = document.getElementById(anchorId);
      if (element) {
        element.scrollIntoView({ behavior: scrollBehavior, block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 8) requestAnimationFrame(retryScroll);
    };
    requestAnimationFrame(retryScroll);
    return;
  }
  if (!element) return;
  element.scrollIntoView({ behavior: scrollBehavior, block: "center" });
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

export function SessionDetail({
  session,
  agentCatalog,
  highlightQuery,
  childSessions = [],
}: SessionDetailProps) {
  const sessionAgentKey = session.reference.agentName;
  const sessionAgent = findAgent(agentCatalog, sessionAgentKey);
  const displayModel = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:buildDisplayModel", () =>
        buildSessionDetailDisplayModel({
          messages: session.messages,
          agentName: sessionAgentKey,
          fileActivity: session.file_activity,
        }),
      ),
    [session.file_activity, session.messages, sessionAgentKey],
  );
  const { messages: messageModels, toc, fileChangeSummary } = displayModel;
  const { state: filterState, actions: filterActions } = useSessionFilters(toc, session.id);
  const [openAuxPanel, setOpenAuxPanel] = useState<"toc" | "files" | null>(null);
  const selection = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:selectDisplayModel", () =>
        displayModel.select(filterState.selected),
      ),
    [displayModel, filterState.selected],
  );
  const { messages: filteredMessages, timelineEntries, visibleUnitCount } = selection;
  const childSessionById = useMemo(
    () => new Map(childSessions.map((child) => [child.id, child])),
    [childSessions],
  );
  const virtualListRef = useRef<MessageListHandle | null>(null);
  const scrollRequestRef = useRef(0);
  const handleJumpToMessageAnchor = useCallback(
    (anchorId: string, messageIndex: number | undefined, behavior: SessionAnchorScrollBehavior) => {
      const requestId = scrollRequestRef.current + 1;
      scrollRequestRef.current = requestId;
      const listIndex = messageIndex == null ? undefined : selection.resolveListIndex(messageIndex);
      scrollToSessionAnchor({
        anchorId,
        behavior,
        prepareAnchor:
          listIndex == null ? undefined : () => virtualListRef.current?.scrollToIndex(listIndex),
        isCurrent: () => scrollRequestRef.current === requestId,
      });
    },
    [selection],
  );
  const handleJumpToAnchor = useCallback(
    (anchorId: string, behavior: SessionAnchorScrollBehavior) => {
      handleJumpToMessageAnchor(anchorId, displayModel.resolveMessageIndex(anchorId), behavior);
    },
    [displayModel, handleJumpToMessageAnchor],
  );

  if (messageModels.length === 0) {
    return (
      <div
        data-testid="session-detail"
        className="mx-auto max-w-4xl rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]"
      >
        This session has no displayable messages.
      </div>
    );
  }

  return (
    <div
      data-testid="session-detail"
      className="mx-auto w-full max-w-[1440px] space-y-8 px-2 md:px-4"
    >
      <SessionSummarySection
        summary={typeof session.summary_files === "string" ? session.summary_files : undefined}
      />
      <div className="grid gap-6 min-[1025px]:grid-cols-[288px_minmax(0,1fr)] min-[1025px]:items-start">
        <SessionDetailAuxControls
          toc={toc}
          state={filterState}
          fileChangeSummary={fileChangeSummary}
          onOpen={setOpenAuxPanel}
        />
        <SessionDetailAuxOverlay
          openPanel={openAuxPanel}
          toc={toc}
          state={filterState}
          actions={filterActions}
          visibleUnitCount={visibleUnitCount}
          fileChangeSummary={fileChangeSummary}
          baseDirectory={session.directory}
          onClose={() => setOpenAuxPanel(null)}
          onJumpToAnchor={(anchorId, behavior) => {
            setOpenAuxPanel(null);
            handleJumpToAnchor(anchorId, behavior);
          }}
        />
        <SessionFilterAside
          toc={toc}
          state={filterState}
          actions={filterActions}
          visibleUnitCount={visibleUnitCount}
          fileChangeSummary={fileChangeSummary}
          baseDirectory={session.directory}
          onJumpToAnchor={handleJumpToAnchor}
        />
        <div className="flex min-w-0 flex-col gap-8">
          <SessionFilterChips toc={toc} state={filterState} actions={filterActions} />
          {filteredMessages.length > 0 ? (
            <>
              <SessionMessageTimeline
                entries={timelineEntries}
                onNavigate={(entry, behavior) =>
                  handleJumpToMessageAnchor(entry.anchorId, entry.messageIndex, behavior)
                }
              />
              <RenderProfiler
                id="MessageList"
                detail={{
                  messages: filteredMessages.length,
                  virtualized: filteredMessages.length > VIRTUALIZED_MESSAGE_THRESHOLD,
                }}
              >
                <MessageList
                  key={session.id}
                  messages={filteredMessages}
                  sessionAgentKey={sessionAgentKey}
                  agent={sessionAgent}
                  baseDirectory={session.directory}
                  highlightQuery={highlightQuery}
                  childSessionById={childSessionById}
                  apiRef={virtualListRef}
                />
              </RenderProfiler>
            </>
          ) : (
            <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
              No messages match the current filters.
            </div>
          )}
          <HiddenToolsFooter
            hiddenCount={deriveHiddenCount(toc, filterState)}
            hiddenTools={deriveHiddenTools(toc, filterState)}
            onShowAll={filterActions.resetAll}
          />
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
    <section className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)]">
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
