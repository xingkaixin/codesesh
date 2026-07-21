declare const __APP_VERSION__: string;

import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation, useMatches, useNavigate } from "react-router-dom";
import type { BookmarkedSessionSnapshot, SessionHead } from "./lib/api";
import { logClientEvent } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CopyResumeButton } from "./components/CopyResumeButton";
import { SessionAliasDialog, type SessionAliasTarget } from "./components/SessionAliasDialog";
import { TimeWindowControl } from "./components/TimeWindowControl";
import { RenderProfiler } from "./components/RenderProfiler";
import { viewStateFromRouteMatches } from "./lib/view-state";
import { useScanStatus } from "./hooks/useScanStatus";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useSessionSearch } from "./hooks/useSessionSearch";
import { useBookmarks } from "./hooks/useBookmarks";
import { useDashboard } from "./hooks/useDashboard";
import { useSidebarModel } from "./hooks/useSidebarModel";
import { useSessionStore } from "./hooks/useSessionStore";
import { useSessionAliasMutations } from "./hooks/useSessionAliasMutations";
import { useWindowedDataLoad } from "./hooks/useWindowedDataLoad";
import { useLiveSync } from "./hooks/useLiveSync";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTimeWindow } from "./hooks/useTimeWindow";
import { useUiPreferences } from "./hooks/useUiPreferences";
import { ResolvedThemeContext, useTheme } from "./hooks/useTheme";
import { buildRouteHeaderModel } from "./lib/build-route-header-model";
import { AppSidebar } from "./components/app/AppSidebar";
import { ShortcutHelpDialog } from "./components/app/ShortcutHelpDialog";
import { ThemeToggle } from "./components/app/ThemeToggle";
import { AppRouteContent } from "./components/app/AppRouteContent";
import type { BrowseBy } from "./components/app/types";
import { formatScanStatusLabel, formatSearchSubtitle } from "./lib/scan-format";
import { getProjectIdentityKey, getProjectPath, type ProjectRouteIdentity } from "./lib/projects";
import { buildSessionIndexes, getSessionAgentKey } from "./lib/session-indexes";

export default function App() {
  const navigate = useNavigate();
  const sessionStore = useSessionStore();
  const timeWindowController = useTimeWindow(sessionStore.config?.window);
  const { timeWindow } = timeWindowController;
  const {
    activeAgents,
    agentCatalog,
    sessions,
    projects,
    dashboard,
    window: loadedWindow,
    validAgentKeys,
    agentNameMap,
    loading,
    error,
    reload,
    applyLiveEvent,
  } = sessionStore;
  useWindowedDataLoad({
    window: timeWindow,
    reload,
  });

  const [selectedProjectIdentity, setSelectedProjectIdentity] =
    useState<ProjectRouteIdentity | null>(null);
  const { scanStatus, setScanStatus } = useScanStatus();
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const {
    shortcutHintDismissed,
    sidebarCollapsed,
    theme,
    dismissShortcutHint,
    setSidebarCollapsed,
    setTheme,
  } = useUiPreferences();
  const resolvedTheme = useTheme(theme);
  const [aliasTarget, setAliasTarget] = useState<SessionAliasTarget | null>(null);

  const location = useLocation();
  const routeMatches = useMatches();
  const viewState = useMemo(
    () => viewStateFromRouteMatches(routeMatches, validAgentKeys),
    [routeMatches, validAgentKeys],
  );

  const sessionDetail = useSessionDetail(viewState);
  const { session, sessionError } = sessionDetail;

  useEffect(() => {
    logClientEvent("route.change", {
      path: location.pathname,
      mode: viewState.mode,
      agent: viewState.activeAgentKey,
      session: viewState.activeSessionSlug,
    });
  }, [location.pathname, viewState.mode, viewState.activeAgentKey, viewState.activeSessionSlug]);

  useEffect(() => {
    if (viewState.mode !== "project") return;
    setSelectedProjectIdentity({
      kind: viewState.activeProjectKind,
      key: viewState.activeProjectKey,
    });
  }, [viewState]);
  const sessionIndexes = useMemo(
    () => buildSessionIndexes(sessions, activeAgents),
    [sessions, activeAgents],
  );

  const search = useSessionSearch(sessionIndexes, loadedWindow);
  const {
    draftSearchQuery,
    activeSearchQuery,
    searchMode,
    searchState,
    searchResults,
    searchLoading,
    selectedSearchIndex,
    searchInputRef,
    setDraftSearchQuery,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
  } = search;
  const isSearchMode = searchMode;
  const detailHighlightQuery = isSearchMode
    ? activeSearchQuery
    : typeof location.state === "object" &&
        location.state !== null &&
        "searchQuery" in location.state &&
        typeof location.state.searchQuery === "string"
      ? location.state.searchQuery
      : "";

  const bookmarks = useBookmarks(sessions);
  const {
    bookmarkedSessions,
    isSessionBookmarked,
    toggleBookmark,
    toggleSessionBookmark,
    refresh: refreshBookmarks,
  } = bookmarks;

  const activeProjectKind = viewState.mode === "project" ? viewState.activeProjectKind : null;
  const activeProjectKey = viewState.mode === "project" ? viewState.activeProjectKey : null;

  const projectDashboardFilters = useMemo(
    () => ({
      projectKind: activeProjectKind ?? undefined,
      projectKey: activeProjectKey ?? undefined,
      identityKey:
        activeProjectKind && activeProjectKey
          ? getProjectIdentityKey({ kind: activeProjectKind, key: activeProjectKey })
          : undefined,
    }),
    [activeProjectKey, activeProjectKind],
  );
  const projectController = useDashboard(loadedWindow, projectDashboardFilters);
  const sidebar = useSidebarModel({
    viewState,
    sessionIndexes,
    session,
    agents: activeAgents,
    projects,
    selectedProjectAgent: projectController.selectedAgent,
    isSessionBookmarked,
  });
  const {
    browseBy,
    selectBrowseBy,
    activeAgentKey,
    activeAgent,
    activeProject,
    activeProjectSessions,
    openedSessionProjectIdentity,
    selectedProjectNavigation,
    sidebarSessions,
    sidebarSessionLookup,
    bookmarkedSidebarSessionIds,
  } = sidebar;
  const selectedProjectNavigationIdentity = selectedProjectNavigation?.identity ?? null;
  const selectedProjectNavigationId = selectedProjectNavigation?.identityKey ?? null;

  const handleSelectFlatSidebarSession = useCallback(
    (sessionItem: SessionHead) => {
      setSelectedSidebarSessionId(sessionItem.id);
      navigate(`/${sessionItem.slug}`);
    },
    [navigate],
  );

  const handleToggleSidebarSessionBookmark = useCallback(
    (sessionItem: SessionHead) => {
      toggleSessionBookmark(sessionItem, getSessionAgentKey(sessionItem));
    },
    [toggleSessionBookmark],
  );

  const handleRenameSession = useCallback((sessionItem: SessionHead) => {
    setAliasTarget({
      agentKey: getSessionAgentKey(sessionItem),
      sessionId: sessionItem.id,
      title: sessionItem.title,
      displayTitle: sessionItem.display_title,
    });
  }, []);

  const handleRenameBookmarkedSession = useCallback((session: BookmarkedSessionSnapshot) => {
    setAliasTarget({
      agentKey: session.agentKey,
      sessionId: session.sessionId,
      title: session.title,
      displayTitle: session.display_title,
    });
  }, []);

  const handleSelectTreeSidebarSession = useCallback(
    (sessionId: string) => {
      setSelectedSidebarSessionId(sessionId);
      const selected = sidebarSessionLookup.byId.get(sessionId);
      if (selected) navigate(`/${selected.slug}`);
    },
    [navigate, sidebarSessionLookup],
  );

  // 可见标签每次渲染直接计算，保证 processed/total 计数实时更新。
  const scanStatusLabel = formatScanStatusLabel(scanStatus);

  // 播报文本节流：processed/total 逐条 tick 高频变化，仅当 phase/当前 agent/完成数
  // 等里程碑信息变化时才重算，避免 aria-live 区域被逐条计数刷屏。
  const scanStatusMilestoneKey = scanStatus
    ? [
        scanStatus.phase,
        scanStatus.scanningAgents[0] ?? "",
        scanStatus.completedAgents.length,
        scanStatus.totalAgents,
        scanStatus.backfill.active,
        scanStatus.backfill.currentAgent ?? "",
        scanStatus.backfill.pendingAgents.length,
        scanStatus.backfill.failedAgents.length,
      ].join("|")
    : null;
  const [announcedScanKey, setAnnouncedScanKey] = useState(scanStatusMilestoneKey);
  const [announcedScanLabel, setAnnouncedScanLabel] = useState(scanStatusLabel);
  if (scanStatusMilestoneKey !== announcedScanKey) {
    setAnnouncedScanKey(scanStatusMilestoneKey);
    setAnnouncedScanLabel(scanStatusLabel);
  }
  const isScanActive = scanStatus?.active === true;

  const { liveNotice } = useLiveSync({
    applyLiveEvent,
    setScanStatus,
  });

  const refreshAliasViews = useCallback(async () => {
    await Promise.all([timeWindow ? reload(timeWindow) : undefined, refreshBookmarks()]);
  }, [refreshBookmarks, reload, timeWindow]);
  const { saveAlias, removeAlias } = useSessionAliasMutations(refreshAliasViews);

  const saveSessionAlias = useCallback(
    async (alias: string) => {
      if (!aliasTarget) return;
      await saveAlias(aliasTarget, alias);
    },
    [aliasTarget, saveAlias],
  );

  const removeSessionAlias = useCallback(async () => {
    if (!aliasTarget) return;
    await removeAlias(aliasTarget);
  }, [aliasTarget, removeAlias]);

  useEffect(() => {
    if (isSearchMode) return;

    if (viewState.mode === "session") {
      setSelectedSidebarSessionId(viewState.activeSessionSlug);
      return;
    }

    if (viewState.mode === "agent") {
      setSelectedSidebarSessionId(null);
      return;
    }

    setSelectedSidebarSessionId(null);
  }, [isSearchMode, viewState.mode, viewState.activeSessionSlug, sidebarSessions]);

  const searchSubtitle =
    searchState.status === "failed"
      ? `Search failed for "${activeSearchQuery}"`
      : formatSearchSubtitle(activeSearchQuery, searchLoading, searchResults.length);

  const routeHeader = buildRouteHeaderModel({
    viewState,
    browseBy,
    isSearchMode,
    searchSubtitle,
    dashboard,
    projects,
    sessionCount: sessions.length,
    activeProject: activeProject?.project ?? null,
    activeAgent,
    sidebarSessionCount: sidebarSessions.length,
    session,
    sessionError,
    selectedProjectIdentity: selectedProjectNavigationIdentity,
    selectedProject: selectedProjectNavigation?.project ?? null,
  });

  const content = (
    <AppRouteContent
      loading={loading}
      error={error}
      viewState={viewState}
      detailHighlightQuery={detailHighlightQuery}
      agents={activeAgents}
      agentCatalog={agentCatalog}
      agentNameMap={agentNameMap}
      projects={projects}
      landingSessions={sessionIndexes.landingSessions}
      sessionsByAgent={sessionIndexes.byLandingAgent}
      activeProject={activeProject?.project ?? null}
      activeProjectSessions={activeProjectSessions}
      dashboard={dashboard}
      sessionDetail={{
        session: sessionDetail.session,
        loading: sessionDetail.sessionLoading,
        error: sessionDetail.sessionError,
      }}
      projectDashboard={{
        dashboard: projectController.dashboard,
        loading: projectController.loading,
        error: projectController.error,
        selectedAgent: projectController.selectedAgent,
        onChangeAgent: projectController.setSelectedAgent,
      }}
      search={{
        active: search.searchMode,
        query: search.activeSearchQuery,
        state: search.searchState,
        projectOptions: search.projectOptions,
        filters: search.searchFilters,
        onChangeFilters: search.setSearchFilters,
        onClose: search.closeSearch,
        onRetry: search.retrySearch,
        selectedIndex: search.selectedSearchIndex,
        registerResultRef: search.registerResultRef,
      }}
      bookmarks={{
        sessions: bookmarks.bookmarkedSessions,
        isBookmarked: bookmarks.isSessionBookmarked,
        toggleBookmark: bookmarks.toggleBookmark,
        toggleSessionBookmark: bookmarks.toggleSessionBookmark,
      }}
    />
  );

  function changeBrowseBy(next: BrowseBy) {
    if (next === "projects" && isScanActive) return;
    selectBrowseBy(next);
    setSelectedSidebarSessionId(null);
    if (next === "projects") {
      const project =
        openedSessionProjectIdentity ??
        (viewState.mode === "session" ? null : selectedProjectIdentity);
      navigate(project ? getProjectPath(project) : "/projects");
      return;
    }
    navigate("/");
  }

  useKeyboardShortcuts({
    viewState,
    browseBy,
    navigate,
    activeAgentKey,
    sidebarSessions,
    sidebarSessionLookup,
    selectedSidebarSessionId,
    setSelectedSidebarSessionId,
    selectedProjectNavigationIdentity,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    dismissShortcutHint,
    isSearchMode,
    activeSearchQuery,
    searchResults,
    selectedSearchIndex,
    setSelectedSearchIndex,
    setDraftSearchQuery,
    openSearch,
    closeSearch,
  });

  return (
    <ResolvedThemeContext.Provider value={resolvedTheme}>
      <div className="console-ui flex h-screen flex-col overflow-hidden bg-[var(--console-bg)] text-[var(--console-text)]">
        <a
          href="#main"
          className="console-mono sr-only rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-1.5 text-xs text-[var(--console-text)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Skip to content
        </a>
        <header className="shrink-0 border-b border-[var(--console-border)] bg-[var(--console-surface)]/85 backdrop-blur-sm">
          <div className="grid min-h-14 grid-cols-[auto_1fr] items-center gap-3 px-4 py-2 sm:grid-cols-[auto_1fr_auto] sm:py-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={!sidebarCollapsed}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1.5 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] lg:inline-flex"
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )}
              </button>
              <Link to="/" className="flex items-center gap-2 text-[var(--console-text)]">
                <img src="/logo.svg?v=3" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
                <span className="console-mono text-sm font-semibold uppercase tracking-[0.05em]">
                  CodeSesh
                </span>
              </Link>
            </div>
            <form
              className="order-3 col-span-2 flex w-full items-center justify-center gap-2 sm:order-none sm:col-span-1 sm:mx-auto sm:max-w-[560px]"
              onSubmit={(event) => {
                event.preventDefault();
                submitSearch();
              }}
            >
              <label className="flex min-w-0 flex-1 items-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 focus-within:border-[var(--console-border-strong)] focus-within:ring-2 focus-within:ring-[var(--console-accent)] focus-within:ring-offset-2">
                <span className="sr-only">Search Sessions</span>
                <input
                  ref={searchInputRef}
                  type="search"
                  name="session-search"
                  autoComplete="off"
                  value={draftSearchQuery}
                  onChange={(event) => setDraftSearchQuery(event.target.value)}
                  placeholder="Search sessions…  /"
                  className="console-mono w-full min-w-0 bg-transparent text-xs text-[var(--console-text)] outline-none placeholder:text-[var(--console-muted)]"
                />
              </label>
              <button
                type="submit"
                className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-3 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                Search
              </button>
            </form>
            <div className="flex items-center justify-end gap-2">
              <ThemeToggle theme={theme} onChange={setTheme} />
              <button
                type="button"
                onClick={() => {
                  setShortcutHelpOpen(true);
                  dismissShortcutHint();
                }}
                className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)]"
                title="Show keyboard shortcuts"
              >
                ?<span className="hidden sm:inline"> Shortcuts</span>
              </button>
              {timeWindow && timeWindowController.preset ? (
                <TimeWindowControl
                  window={timeWindow}
                  preset={timeWindowController.preset}
                  customFrom={timeWindowController.customFrom}
                  customTo={timeWindowController.customTo}
                  onSelectPreset={timeWindowController.selectPreset}
                  onSelectCustom={timeWindowController.selectCustom}
                />
              ) : null}
              <span className="console-mono hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-muted)] sm:inline-flex">
                v{__APP_VERSION__}
              </span>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <AppSidebar
            model={{
              sidebarCollapsed,
              browseBy,
              isScanActive,
              viewState,
              agents: activeAgents,
              agentCatalog,
              activeAgentKey,
              scanStatus,
              projects,
              selectedProjectNavigationId,
              loading,
              bookmarkedSessions,
              sidebarSessions,
              selectedSidebarSessionId,
              bookmarkedSidebarSessionIds,
            }}
            actions={{
              onChangeBrowseBy: changeBrowseBy,
              onSelectProject: setSelectedProjectIdentity,
              onToggleBookmark: toggleBookmark,
              onSelectFlatSidebarSession: handleSelectFlatSidebarSession,
              onToggleSidebarSessionBookmark: handleToggleSidebarSessionBookmark,
              onRenameSession: handleRenameSession,
              onRenameBookmarkedSession: handleRenameBookmarkedSession,
              onSelectTreeSidebarSession: handleSelectTreeSidebarSession,
            }}
          />

          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            <section className="shrink-0 border-b border-[var(--console-border)] bg-[var(--console-surface)]/70 px-4 py-4 backdrop-blur-sm md:px-8">
              <div>
                <nav
                  aria-label="Breadcrumb"
                  className="console-mono mb-2 flex flex-wrap items-center gap-1 text-[11px] text-[var(--console-muted)]"
                >
                  {routeHeader.breadcrumbs.map((item, index) => (
                    <span key={`${item.label}-${index}`} className="flex items-center gap-1">
                      {item.to ? (
                        <Link
                          to={item.to}
                          className="motion-hover hover:text-[var(--console-text)]"
                        >
                          {item.label}
                        </Link>
                      ) : (
                        <span className="text-[var(--console-text)]">{item.label}</span>
                      )}
                      {index < routeHeader.breadcrumbs.length - 1 ? <span>/</span> : null}
                    </span>
                  ))}
                </nav>
                <div className="flex items-center gap-2">
                  <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--console-muted)]">
                    {routeHeader.contextLabel}
                  </span>
                  <h1 className="console-mono text-xl font-semibold tracking-tight text-[var(--console-text)]">
                    {routeHeader.title}
                  </h1>
                </div>
                <div className="console-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--console-muted)]">
                  {routeHeader.subtitle}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!shortcutHintDismissed ? (
                    <div className="console-mono inline-flex items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
                      <span>Keyboard navigation available</span>
                      <span className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1">
                        ?
                      </span>
                      <button
                        type="button"
                        onClick={dismissShortcutHint}
                        className="text-[var(--console-muted)] motion-hover hover:text-[var(--console-text)]"
                        aria-label="Dismiss keyboard shortcuts hint"
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  {!isSearchMode && viewState.mode === "session" ? (
                    <span className="console-mono inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
                      Esc back
                    </span>
                  ) : null}
                  {!isSearchMode && viewState.mode === "session" && session ? (
                    <CopyResumeButton
                      agentName={viewState.activeAgentKey}
                      sessionId={session.id}
                      directory={session.directory}
                    />
                  ) : null}
                </div>
                <div aria-live="polite">
                  {liveNotice ? (
                    <p className="console-mono mt-2 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
                      {liveNotice}
                    </p>
                  ) : null}
                </div>
                <div>
                  {scanStatusLabel && viewState.mode === "root" ? (
                    <p className="console-mono mt-2 inline-flex max-w-4xl rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--console-warning)]">
                      {scanStatusLabel}
                    </p>
                  ) : null}
                </div>
                <div className="sr-only" aria-live="polite" aria-atomic="true">
                  {viewState.mode === "root" ? announcedScanLabel : null}
                </div>
              </div>
            </section>

            <section className="console-scrollbar bg-grid min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
              <ErrorBoundary>
                <RenderProfiler
                  id="MainContent"
                  detail={{
                    mode: viewState.mode,
                    search: isSearchMode,
                    sessions: sessions.length,
                  }}
                >
                  {content}
                </RenderProfiler>
              </ErrorBoundary>
            </section>
          </main>
        </div>
        <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
        <SessionAliasDialog
          target={aliasTarget}
          onClose={() => setAliasTarget(null)}
          onSave={saveSessionAlias}
          onRemove={removeSessionAlias}
        />
      </div>
    </ResolvedThemeContext.Provider>
  );
}
