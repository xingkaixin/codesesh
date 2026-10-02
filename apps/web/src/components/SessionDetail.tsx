import type { SessionMessagePaging } from "../hooks/useSessionDetail";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { ChevronDown, ChevronUp, FileText } from "./ui/icons";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { formatSessionReference } from "@codesesh/contract";
import { useLocation } from "react-router-dom";
import { findAgent, type AgentCatalog } from "../lib/agents";
import type { SessionDetail as SessionDetailData, SessionHead } from "../lib/api";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import { buildSessionDetailDisplayModel } from "./session-detail/display-model";
import { SessionFilterAside } from "./session-detail/filter-panel";
import { SessionFilterChips } from "./session-detail/filter-chips";
import {
  deriveHiddenCount,
  deriveHiddenTools,
  deriveSelectedFilters,
} from "./session-detail/filter-state";
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
import {
  createTimelineAnchorRegistry,
  type TimelineAnchorRegistry,
} from "./session-detail/timeline-anchor-registry";

const PAGING_MESSAGES = {
  "Loaded {0} of {1} messages": [
    "已加载 {0} / {1} 条消息",
    "{1} 件中 {0} 件のメッセージを読み込みました",
  ],
  "Filters and navigation apply to loaded messages.": [
    "筛选和消息导航仅作用于已加载的消息。",
    "フィルターとメッセージナビゲーションは読み込み済みの内容に適用されます。",
  ],
  "Load more messages": ["加载更多消息", "さらにメッセージを読み込む"],
  "Loading search match…": ["正在加载搜索命中位置…", "検索結果の位置を読み込み中…"],
  "Couldn’t load more messages. Try again.": [
    "无法加载更多消息，请重试。",
    "追加のメッセージを読み込めませんでした。再試行してください。",
  ],
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionDetailData;
  agentCatalog: AgentCatalog;
  highlightQuery?: string;
  targetMessageIndex?: number;
  messagePaging?: SessionMessagePaging;
  childSessions?: SessionHead[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function scrollToSessionAnchor({
  anchorId,
  behavior,
  anchorRegistry,
  prepareAnchor,
  isCurrent,
}: {
  anchorId: string;
  behavior: SessionAnchorScrollBehavior;
  anchorRegistry: TimelineAnchorRegistry;
  prepareAnchor?: () => void;
  isCurrent: () => boolean;
}) {
  if (typeof document === "undefined") return;
  const scrollBehavior = resolveReducedMotionScrollBehavior(
    behavior,
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  let element = anchorRegistry.get(anchorId);
  if (!element && prepareAnchor) {
    prepareAnchor();
    let attempts = 0;
    const retryScroll = () => {
      if (!isCurrent()) return;
      element = anchorRegistry.get(anchorId);
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

export function SessionDetailRoute(props: SessionDetailProps) {
  const { hash } = useLocation();
  const targetMessageIndex = /^#message-\d+$/.test(hash)
    ? Number(hash.slice("#message-".length))
    : undefined;
  return <SessionDetail {...props} targetMessageIndex={targetMessageIndex} />;
}

export function SessionDetail({
  session,
  agentCatalog,
  highlightQuery,
  targetMessageIndex,
  messagePaging,
  childSessions = [],
}: SessionDetailProps) {
  const locale = useLocale();

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

    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, session.file_activity, session.messages, sessionAgentKey],
  );
  const { messages: messageModels, toc, fileChangeSummary } = displayModel;
  const sessionReference = formatSessionReference(session.reference);
  const { state: filterState, actions: filterActions } = useSessionFilters(toc, sessionReference);
  const [openAuxPanel, setOpenAuxPanel] = useState<"toc" | "files" | null>(null);
  const selection = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:selectDisplayModel", () =>
        displayModel.select(deriveSelectedFilters(toc, filterState.excluded)),
      ),

    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, displayModel, toc, filterState.excluded],
  );
  const { messages: filteredMessages, timelineEntries, visibleUnitCount } = selection;
  const childSessionById = useMemo(
    () => new Map(childSessions.map((child) => [child.reference.sessionId, child])),
    [childSessions],
  );
  const [anchorRegistry] = useState(createTimelineAnchorRegistry);
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
        anchorRegistry,
        prepareAnchor:
          listIndex == null ? undefined : () => virtualListRef.current?.scrollToIndex(listIndex),
        isCurrent: () => scrollRequestRef.current === requestId,
      });
    },
    [anchorRegistry, selection],
  );
  const handleJumpToAnchor = useCallback(
    (anchorId: string, behavior: SessionAnchorScrollBehavior) => {
      handleJumpToMessageAnchor(anchorId, displayModel.resolveMessageIndex(anchorId), behavior);
    },
    [displayModel, handleJumpToMessageAnchor],
  );

  const jumpToSearchMessage = useEffectEvent(() => {
    if (targetMessageIndex == null) return;
    const target = displayModel.resolveSourceMessageAnchor(targetMessageIndex);
    if (!target) return;
    handleJumpToMessageAnchor(target.anchorId, target.messageIndex, "auto");
    return () => {
      scrollRequestRef.current += 1;
    };
  });
  const targetMessageLoaded =
    targetMessageIndex != null && targetMessageIndex < session.messages.length;
  useEffect(
    () => jumpToSearchMessage(),
    [sessionReference, targetMessageIndex, targetMessageLoaded],
  );
  const targetMessagePending =
    targetMessageIndex != null &&
    Number.isSafeInteger(targetMessageIndex) &&
    !targetMessageLoaded &&
    targetMessageIndex < (session.message_total ?? 0);
  const loadMore = messagePaging?.loadMore;
  const pageLoading = messagePaging?.loading ?? false;
  const pageFailed = messagePaging?.failed ?? false;
  useEffect(() => {
    if (targetMessagePending && !pageLoading && !pageFailed) loadMore?.();
  }, [targetMessagePending, pageLoading, pageFailed, loadMore, session.messages.length]);

  const pageControls = messagePaging ? (
    <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 text-xs leading-5 text-[var(--console-muted)]">
      <p role="status">
        {t(
          "Loaded {0} of {1} messages",
          [session.messages.length, session.message_total ?? 0],
          locale,
          PAGING_MESSAGES,
        )}
        {targetMessagePending && !pageFailed
          ? ` · ${t("Loading search match…", [], locale, PAGING_MESSAGES)}`
          : ""}
      </p>
      <p>{t("Filters and navigation apply to loaded messages.", [], locale, PAGING_MESSAGES)}</p>
      {pageFailed && (
        <p role="alert">
          {t("Couldn’t load more messages. Try again.", [], locale, PAGING_MESSAGES)}
        </p>
      )}
      <button
        type="button"
        disabled={pageLoading}
        onClick={loadMore}
        className="mt-2 rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
      >
        {pageLoading ? t("Loading…") : t("Load more messages", [], locale, PAGING_MESSAGES)}
      </button>
    </div>
  ) : null;

  if (messageModels.length === 0) {
    return (
      <div
        data-testid="session-detail"
        className="mx-auto max-w-4xl rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]"
      >
        {pageControls}
        {t("This session has no displayable messages.")}
      </div>
    );
  }

  return (
    <div
      data-testid="session-detail"
      className="mx-auto w-full max-w-[1440px] space-y-8 px-2 md:px-4"
    >
      {pageControls}
      <SessionSummarySection
        summary={typeof session.summary_files === "string" ? session.summary_files : undefined}
      />
      <div className="grid gap-6 min-[1280px]:grid-cols-[288px_minmax(0,1fr)] min-[1280px]:items-start">
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
                anchorRegistry={anchorRegistry}
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
                  key={sessionReference}
                  messages={filteredMessages}
                  sessionAgentKey={sessionAgentKey}
                  agent={sessionAgent}
                  baseDirectory={session.directory}
                  highlightQuery={highlightQuery}
                  childSessionById={childSessionById}
                  apiRef={virtualListRef}
                  anchorRegistry={anchorRegistry}
                />
              </RenderProfiler>
            </>
          ) : (
            <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
              {t("No messages match the current filters.")}
            </div>
          )}
          <HiddenToolsFooter
            hiddenCount={deriveHiddenCount(toc, filterState)}
            hiddenTools={deriveHiddenTools(toc, filterState)}
            onShowAll={filterActions.resetAll}
          />
        </div>
      </div>
      <DeferredInteractiveReceipt session={session} messagePaging={messagePaging} />
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
  useLocale();

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
          <FileText className="size-3.5 text-[var(--console-accent)]" /> {t("Session Summary")}
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
