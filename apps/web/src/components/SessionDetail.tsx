import type { SessionMessagePaging } from "../hooks/useSessionDetail";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { ChevronDown, ChevronUp, ChevronsUpDown, FileText, Search, X } from "./ui/icons";
import { Kbd } from "./ui/kbd";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  formatSessionReference,
  type SessionDetail as SessionDetailData,
  type SessionHead,
} from "@codesesh/contract";
import { useLocation } from "react-router-dom";
import { findAgent, type AgentCatalog } from "../lib/agents";
import { MarkdownContent } from "./MarkdownContent";
import {
  isRenderProfilerEnabled,
  recordRenderProfileEntry,
  RenderProfiler,
} from "./RenderProfiler";
import { buildSessionDetailDisplayModel } from "./session-detail/display-model";
import { SessionFilterAside } from "./session-detail/FilterPanel";
import { SessionFilterChips } from "./session-detail/FilterChips";
import {
  collectMatchedCollapsibleKeys,
  createExpandedItemsRegistry,
  deriveExpandedSummary,
  ExpandedItemsProvider,
  useExpandedItemsSnapshot,
} from "./session-detail/ExpandedItemsRegistry";
import {
  deriveHiddenCount,
  deriveHiddenTools,
  deriveSelectedFilters,
} from "./session-detail/filter-state";
import { HiddenToolsFooter } from "./session-detail/HiddenToolsFooter";
import { useSessionFilters } from "./session-detail/useSessionFilters";
import {
  MessageList,
  type MessageListHandle,
  VIRTUALIZED_MESSAGE_THRESHOLD,
} from "./session-detail/MessageList";
import {
  DeferredInteractiveReceipt,
  SessionDetailAuxControls,
  SessionDetailAuxOverlay,
} from "./session-detail/SessionDetailAux";
import { SessionMessageTimeline } from "./session-detail/SessionMessageTimeline";
import { MessagePagingControls } from "./session-detail/MessagePagingControls";
import { SessionFindBar } from "./session-detail/SessionFindBar";
import type { LoadedSessionFindMatch } from "./session-detail/session-find";
import { useSessionFind, useSessionFindState } from "./session-detail/useSessionFind";
import { SessionStats } from "./session-detail/SessionStats";
import { SessionSubSessions } from "./session-detail/SessionSubSessions";
import {
  findScrollParent,
  isWindowScrollParent,
  resolveReducedMotionScrollBehavior,
  type SessionAnchorScrollBehavior,
} from "./session-detail/scroll-behavior";
import {
  createTimelineAnchorRegistry,
  type TimelineAnchorRegistry,
} from "./session-detail/TimelineAnchorRegistry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  session: SessionDetailData;
  agentCatalog: AgentCatalog;
  highlightQuery?: string;
  onClearHighlight?: () => void;
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
  onScrolled,
  isCurrent,
}: {
  anchorId: string;
  behavior: SessionAnchorScrollBehavior;
  anchorRegistry: TimelineAnchorRegistry;
  prepareAnchor?: () => void;
  onScrolled: () => void;
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
        if (scrollBehavior === "auto") onScrolled();
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
  if (scrollBehavior === "auto") onScrolled();
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
  onClearHighlight,
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
  const findState = useSessionFindState(sessionReference);
  const searchingAll = findState.state.open && Boolean(findState.state.query.trim());
  const selection = useMemo(
    () =>
      measureSessionDetailWork("SessionDetail:selectDisplayModel", () =>
        displayModel.select(
          searchingAll ? toc.filterIds : deriveSelectedFilters(toc, filterState.excluded),
        ),
      ),

    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, displayModel, toc, filterState.excluded, searchingAll],
  );
  const { messages: filteredMessages, timelineEntries, visibleUnitCount } = selection;
  const childSessionById = useMemo(
    () => new Map(childSessions.map((child) => [child.reference.sessionId, child])),
    [childSessions],
  );
  const [anchorRegistry] = useState(createTimelineAnchorRegistry);
  const trimmedHighlightQuery = highlightQuery?.trim() ?? "";
  const [dismissedHighlight, setDismissedHighlight] = useState<{
    sessionKey: string;
    query: string;
  } | null>(null);
  const effectiveHighlightQuery =
    dismissedHighlight?.sessionKey === sessionReference &&
    dismissedHighlight.query === trimmedHighlightQuery
      ? ""
      : trimmedHighlightQuery;
  const handleClearHighlight = useCallback(() => {
    setDismissedHighlight({ sessionKey: sessionReference, query: trimmedHighlightQuery });
    onClearHighlight?.();
  }, [onClearHighlight, sessionReference, trimmedHighlightQuery]);

  const expandedItems = useMemo(
    () => createExpandedItemsRegistry(sessionReference),
    [sessionReference],
  );
  const expandedSnapshot = useExpandedItemsSnapshot(expandedItems);
  const { hasCollapsible, allExpanded } = useMemo(
    () =>
      deriveExpandedSummary(filteredMessages, expandedSnapshot, sessionAgentKey, session.directory),
    [filteredMessages, expandedSnapshot, sessionAgentKey, session.directory],
  );
  const detailRef = useRef<HTMLDivElement>(null);
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
        onScrolled: () => virtualListRef.current?.captureAnchor(),
        isCurrent: () => scrollRequestRef.current === requestId,
      });
    },
    [anchorRegistry, selection],
  );
  const handleJumpToFindMatch = useCallback(
    (match: LoadedSessionFindMatch, behavior: SessionAnchorScrollBehavior) => {
      handleJumpToMessageAnchor(match.anchorId, match.displayMessageIndex, behavior);
    },
    [handleJumpToMessageAnchor],
  );
  const sessionFind = useSessionFind({
    findState,
    session,
    sessionReference,
    displayModel,
    filteredMessages,
    effectiveHighlightQuery,
    onJumpToLoadedMatch: handleJumpToFindMatch,
  });
  const activeHighlightQuery = sessionFind.trimmedQuery || effectiveHighlightQuery;
  const targetDisplayMessageIndex = useMemo(
    () =>
      targetMessageIndex == null
        ? undefined
        : displayModel.resolveSourceMessageAnchor(targetMessageIndex)?.messageIndex,
    [displayModel, targetMessageIndex],
  );
  const activeTargetDisplayMessageIndex =
    sessionFind.activeDisplayMessageIndex ?? targetDisplayMessageIndex;
  const matchedCollapsibleKeys = useMemo(
    () =>
      collectMatchedCollapsibleKeys(
        filteredMessages,
        activeHighlightQuery,
        activeTargetDisplayMessageIndex,
      ),
    [activeHighlightQuery, activeTargetDisplayMessageIndex, filteredMessages],
  );
  const autoExpandedRef = useRef<{ scope: string; keys: Set<string> }>({
    scope: "",
    keys: new Set(),
  });
  useEffect(() => {
    const scope = `${sessionReference}\0${activeHighlightQuery}\0${activeTargetDisplayMessageIndex ?? ""}`;
    if (autoExpandedRef.current.scope !== scope) {
      autoExpandedRef.current = { scope, keys: new Set() };
    }
    if (matchedCollapsibleKeys.length === 0) return;
    const newlyMatched: string[] = [];
    for (const key of matchedCollapsibleKeys) {
      if (!autoExpandedRef.current.keys.has(key)) {
        autoExpandedRef.current.keys.add(key);
        newlyMatched.push(key);
      }
    }
    if (newlyMatched.length > 0) {
      expandedItems.expandItems(newlyMatched);
    }
  }, [
    activeHighlightQuery,
    activeTargetDisplayMessageIndex,
    expandedItems,
    matchedCollapsibleKeys,
    sessionReference,
  ]);
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
    let cancelled = false;
    let frame = requestAnimationFrame(async () => {
      const animations =
        detailRef.current
          ?.getAnimations?.({ subtree: true })
          .filter(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.target?.classList.contains("motion-collapsible"),
          ) ?? [];
      if (animations.length)
        await Promise.allSettled(animations.map((animation) => animation.finished));
      if (!cancelled)
        frame = requestAnimationFrame(() =>
          handleJumpToMessageAnchor(target.anchorId, target.messageIndex, "auto"),
        );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      scrollRequestRef.current += 1;
    };
  });
  const targetMessageLoaded =
    targetMessageIndex != null && targetMessageIndex < session.messages.length;
  useEffect(
    () => jumpToSearchMessage(),
    [sessionReference, targetMessageIndex, targetMessageLoaded],
  );
  const pendingSourceTarget = sessionFind.pendingSourceMessageIndex ?? targetMessageIndex;
  const targetMessagePending =
    pendingSourceTarget != null &&
    Number.isSafeInteger(pendingSourceTarget) &&
    pendingSourceTarget >= session.messages.length &&
    pendingSourceTarget < (session.message_total ?? 0);
  const loadMore = messagePaging?.loadMore;
  const pageLoading = messagePaging?.loading ?? false;
  const pageFailed = messagePaging?.failed ?? false;
  const pagingFooterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (targetMessagePending && !pageLoading && !pageFailed) loadMore?.();
  }, [targetMessagePending, pageLoading, pageFailed, loadMore, session.messages.length]);

  useEffect(() => {
    const footer = pagingFooterRef.current;
    if (!footer || !loadMore || pageLoading || pageFailed || targetMessagePending) return;
    const parent = findScrollParent(footer);
    let frame = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        // Let virtual rows mount and establish the reading anchor before extending the list.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(loadMore);
        });
      },
      { root: isWindowScrollParent(parent) ? null : parent, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(footer);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [
    loadMore,
    pageLoading,
    pageFailed,
    targetMessagePending,
    session.messages.length,
    sessionReference,
  ]);

  const pageControls = messagePaging ? (
    <MessagePagingControls
      key={sessionReference}
      loaded={session.messages.length}
      total={session.message_total ?? 0}
      paging={messagePaging}
      searchMatchPending={targetMessagePending}
      showLoadAll
    />
  ) : null;

  const pagingFooter = messagePaging ? (
    <div
      ref={pagingFooterRef}
      data-testid="session-message-paging-footer"
      className="[overflow-anchor:none]"
    >
      <MessagePagingControls
        loaded={session.messages.length}
        total={session.message_total ?? 0}
        paging={messagePaging}
        searchMatchPending={targetMessagePending}
      />
    </div>
  ) : null;

  if (messageModels.length === 0) {
    return (
      <div data-testid="session-detail" className="mx-auto max-w-4xl space-y-4">
        <SessionSubSessions childSessions={childSessions} />
        <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
          {pageControls}
          <div ref={pagingFooterRef}>{t("This session has no displayable messages.")}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={detailRef}
      data-testid="session-detail"
      className="mx-auto w-full max-w-[1440px] space-y-8 px-2 md:px-4"
    >
      <SessionStats session={session} toc={toc} />
      {pageControls}
      <SessionSubSessions childSessions={childSessions} />
      <SessionSummarySection
        summary={typeof session.summary_files === "string" ? session.summary_files : undefined}
      />
      <div className="grid gap-6 min-[1280px]:grid-cols-[minmax(0,1fr)_300px] min-[1280px]:items-start">
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
        <div className="flex min-w-0 flex-col gap-6 min-[1280px]:col-start-1 min-[1280px]:row-start-1">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SessionFilterChips toc={toc} state={filterState} actions={filterActions} />
              {effectiveHighlightQuery ? (
                <span className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full border border-[var(--brand)]/30 bg-[var(--brand-soft)] pr-1 pl-2.5 text-xs text-[var(--brand-ink)]">
                  <Search aria-hidden="true" className="size-3 shrink-0" />
                  <span className="console-mono max-w-[200px] truncate font-medium">
                    {effectiveHighlightQuery}
                  </span>
                  <button
                    type="button"
                    onClick={handleClearHighlight}
                    className="motion-hover inline-flex h-[20px] items-center gap-1 rounded-full px-1.5 text-[11px] font-medium hover:bg-[var(--console-surface)]/60 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                  >
                    <X aria-hidden="true" className="size-3" />
                    {t("Clear highlights")}
                  </button>
                </span>
              ) : null}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-expanded={sessionFind.open}
                  onClick={sessionFind.open ? sessionFind.closeFind : sessionFind.openFind}
                  className="motion-hover inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 text-xs font-medium text-[var(--console-text-secondary)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                >
                  <Search aria-hidden="true" className="size-3.5 text-[var(--console-muted)]" />
                  {t("Find in session")}
                  <span className="hidden sm:inline-flex">
                    <Kbd>F</Kbd>
                  </span>
                </button>
                {hasCollapsible ? (
                  <button
                    type="button"
                    aria-pressed={allExpanded}
                    onClick={() =>
                      allExpanded ? expandedItems.collapseAll() : expandedItems.expandAll()
                    }
                    className="motion-hover inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 text-xs font-medium text-[var(--console-text-secondary)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                  >
                    <ChevronsUpDown className="size-3.5 text-[var(--console-muted)]" />
                    {allExpanded ? t("Collapse all") : t("Expand all")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {sessionFind.open || filteredMessages.length > 0 ? (
            <div className="sticky top-0 z-20 -mx-2 flex flex-col gap-2 bg-[var(--console-bg)] px-2 py-3">
              {sessionFind.open ? (
                <SessionFindBar
                  query={sessionFind.query}
                  inputRef={sessionFind.inputRef}
                  activeIndex={sessionFind.activeIndex}
                  matchCount={sessionFind.matchCount}
                  searching={sessionFind.searching}
                  failed={sessionFind.failed}
                  onRetry={sessionFind.retry}
                  onChangeQuery={sessionFind.updateQuery}
                  onPrev={sessionFind.goPrev}
                  onNext={sessionFind.goNext}
                  onClose={sessionFind.closeFind}
                />
              ) : null}
              {filteredMessages.length > 0 && (
                <SessionMessageTimeline
                  entries={timelineEntries}
                  anchorRegistry={anchorRegistry}
                  onNavigate={(entry, behavior) =>
                    handleJumpToMessageAnchor(entry.anchorId, entry.messageIndex, behavior)
                  }
                />
              )}
            </div>
          ) : null}
          {filteredMessages.length > 0 ? (
            <>
              <ExpandedItemsProvider registry={expandedItems}>
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
                    highlightQuery={activeHighlightQuery || undefined}
                    childSessionById={childSessionById}
                    apiRef={virtualListRef}
                    anchorRegistry={anchorRegistry}
                    followTail={!messagePaging}
                  />
                </RenderProfiler>
              </ExpandedItemsProvider>
            </>
          ) : (
            <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-6 text-sm text-[var(--console-muted)]">
              {t("No messages match the current filters.")}
            </div>
          )}
          {!searchingAll && (
            <HiddenToolsFooter
              hiddenCount={deriveHiddenCount(toc, filterState)}
              hiddenTools={deriveHiddenTools(toc, filterState)}
              onShowAll={filterActions.resetAll}
            />
          )}
          {pagingFooter}
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
        aria-expanded={expanded}
        className="flex min-h-12 w-full items-center justify-between gap-3 px-[18px] py-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none focus-visible:ring-inset"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--console-text)]">
          <FileText className="size-4 text-[var(--console-muted)]" /> {t("Session Summary")}
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 text-[var(--console-muted)]" />
        ) : (
          <ChevronDown className="size-3.5 text-[var(--console-muted)]" />
        )}
      </button>
      {expanded ? (
        <div className="border-t border-[var(--console-border)] px-[18px] py-4">
          <div className="console-markdown text-sm leading-relaxed text-[var(--console-text)]">
            <MarkdownContent text={content} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
