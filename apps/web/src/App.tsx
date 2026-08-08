declare const __APP_VERSION__: string;

import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeftOpen } from "./components/ui/icons";
import { Link, useLocation, useMatches, useNavigate } from "react-router-dom";
import type { BookmarkRecord, SessionHead } from "./lib/api";
import { logClientEvent } from "./lib/api";
import { getSessionRoutePath } from "./lib/session-indexes";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CopyResumeButton } from "./components/CopyResumeButton";
import { SessionAliasDialog, type SessionAliasTarget } from "./components/SessionAliasDialog";
import { TimeWindowControl } from "./components/TimeWindowControl";
import { RenderProfiler } from "./components/RenderProfiler";
import { viewStateFromRouteMatches } from "./lib/view-state";
import { useScanStatusPublisher } from "./hooks/useScanStatus";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useSessionSearch } from "./hooks/useSessionSearch";
import { useBookmarks } from "./hooks/useBookmarks";
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
import { ScanStatusNotice } from "./components/app/ScanStatusNotice";
import { formatSearchSubtitle } from "./lib/scan-format";
import { findAgent } from "./lib/agents";
import { getProjectIdentityKey, type ProjectRouteIdentity } from "./lib/projects";
import {
  buildSessionIndexes,
  getSessionAgentKey,
  getSessionReferenceKey,
  getSessionRouteKey,
} from "./lib/session-indexes";

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
    resyncLiveState,
  } = sessionStore;
  useWindowedDataLoad({
    window: timeWindow,
    reload,
  });

  const [, setSelectedProjectIdentity] = useState<ProjectRouteIdentity | null>(null);
  const setScanStatus = useScanStatusPublisher();
  const [selectedSidebarSessionReference, setSelectedSidebarSessionReference] = useState<
    string | null
  >(null);
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
      session: viewState.activeSessionId,
    });
  }, [location.pathname, viewState.mode, viewState.activeAgentKey, viewState.activeSessionId]);

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

  const activeProjectIdentityKey =
    activeProjectKind && activeProjectKey
      ? getProjectIdentityKey({ kind: activeProjectKind, key: activeProjectKey })
      : null;

  const [projectAgentFilter, setProjectAgentFilter] = useState<{
    identityKey: string;
    agentKey?: string;
  } | null>(null);
  const selectedProjectAgent =
    projectAgentFilter?.identityKey === activeProjectIdentityKey
      ? projectAgentFilter?.agentKey
      : undefined;
  const selectProjectAgent = useCallback(
    (agentKey?: string) => {
      setProjectAgentFilter(
        activeProjectIdentityKey ? { identityKey: activeProjectIdentityKey, agentKey } : null,
      );
    },
    [activeProjectIdentityKey],
  );
  const sidebar = useSidebarModel({
    viewState,
    sessionIndexes,
    session,
    agents: activeAgents,
    projects,
    selectedProjectAgent,
    isSessionBookmarked,
  });
  const {
    activeAgent,
    activeProject,
    activeProjectSessions,
    selectedProjectNavigation,
    sidebarSessions,
    sidebarSessionLookup,
    bookmarkedSidebarSessionReferences,
  } = sidebar;
  const selectedProjectNavigationIdentity = selectedProjectNavigation?.identity ?? null;
  const selectedProjectNavigationId = selectedProjectNavigation?.identityKey ?? null;

  const handleSelectFlatSidebarSession = useCallback(
    (sessionItem: SessionHead) => {
      setSelectedSidebarSessionReference(getSessionReferenceKey(sessionItem));
      navigate(getSessionRoutePath(sessionItem));
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

  const handleRenameBookmarkedSession = useCallback((bookmark: BookmarkRecord) => {
    setAliasTarget({
      agentKey: bookmark.reference.agentName,
      sessionId: bookmark.reference.sessionId,
      title: bookmark.session.title,
      displayTitle: bookmark.session.display_title,
    });
  }, []);

  const { liveNotice } = useLiveSync({
    applyLiveEvent,
    resyncLiveState,
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
      setSelectedSidebarSessionReference(
        getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionId),
      );
      return;
    }

    if (viewState.mode === "agent") {
      setSelectedSidebarSessionReference(null);
      return;
    }

    setSelectedSidebarSessionReference(null);
  }, [
    isSearchMode,
    viewState.mode,
    viewState.activeAgentKey,
    viewState.activeSessionId,
    sidebarSessions,
  ]);

  const searchSubtitle =
    searchState.status === "failed"
      ? `Search failed for "${activeSearchQuery}"`
      : formatSearchSubtitle(activeSearchQuery, searchLoading, searchResults.length);

  const routeHeader = buildRouteHeaderModel({
    viewState,
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
      sessions={sessions}
      sessionsByAgent={sessionIndexes.byLandingAgent}
      activeProject={activeProject?.project ?? null}
      activeProjectSessions={activeProjectSessions}
      overview={{
        window: loadedWindow,
        // `preset` is null only until the config resolves, and until then the
        // shell renders its loading skeleton instead of the overview.
        rangePreset: timeWindowController.preset ?? "all",
        onRangeChange: timeWindowController.selectPreset,
        onSelectCustom: timeWindowController.selectCustom,
      }}
      sessionDetail={{
        session: sessionDetail.session,
        loading: sessionDetail.sessionLoading,
        error: sessionDetail.sessionError,
      }}
      projectAgentFilter={{
        selectedAgent: selectedProjectAgent,
        onChangeAgent: selectProjectAgent,
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
        isBookmarked: bookmarks.isSessionBookmarked,
        toggleSessionBookmark: bookmarks.toggleSessionBookmark,
      }}
    />
  );

  useKeyboardShortcuts({
    viewState,
    navigate,
    sidebarSessions,
    sidebarSessionLookup,
    selectedSidebarSessionReference,
    setSelectedSidebarSessionReference,
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
          className="console-mono sr-only rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-1.5 text-xs text-[var(--console-text)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
        >
          Skip to content
        </a>
        <header className="shrink-0 border-b border-[var(--console-border)] bg-[var(--console-surface)]/85 backdrop-blur-sm">
          <div className="grid min-h-14 grid-cols-[auto_1fr] items-center gap-3 px-4 py-2 sm:grid-cols-[auto_1fr_auto] sm:py-0">
            <div className="flex items-center gap-2">
              <Link to="/" className="flex items-center gap-2 text-[var(--console-text)]">
                <img src="/logo.svg?v=3" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
                <span className="console-display text-sm font-semibold uppercase tracking-[0.05em]">
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
              <label className="flex min-w-0 flex-1 items-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 focus-within:border-[var(--brand-line)] focus-within:ring-2 focus-within:ring-[var(--brand)]">
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
                className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-3 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
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
                className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
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
              viewState,
              agentCatalog,
              projects,
              selectedProjectNavigationId,
              loading,
              bookmarkedSessions,
              sidebarSessions,
              selectedSidebarSessionReference,
              bookmarkedSidebarSessionReferences,
            }}
            actions={{
              onCollapse: () => setSidebarCollapsed(true),
              onSelectProject: setSelectedProjectIdentity,
              onToggleBookmark: toggleBookmark,
              onSelectFlatSidebarSession: handleSelectFlatSidebarSession,
              onToggleSidebarSessionBookmark: handleToggleSidebarSessionBookmark,
              onRenameSession: handleRenameSession,
              onRenameBookmarkedSession: handleRenameBookmarkedSession,
            }}
          />

          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            <section className="flex shrink-0 items-start gap-3 border-b border-[var(--console-border)] bg-[var(--console-surface)]/70 px-4 py-4 backdrop-blur-sm md:px-8">
              {sidebarCollapsed ? (
                <button
                  type="button"
                  aria-expanded="false"
                  aria-label="Expand sidebar"
                  title="Expand sidebar"
                  onClick={() => setSidebarCollapsed(false)}
                  className="mt-0.5 hidden shrink-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none lg:inline-flex"
                >
                  <PanelLeftOpen className="size-4" />
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
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
                  <span className="console-eyebrow rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5">
                    {routeHeader.contextLabel}
                  </span>
                  <h1 className="console-display text-2xl font-semibold text-[var(--console-text)]">
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
                      resumeCommandPrefix={
                        findAgent(agentCatalog, viewState.activeAgentKey)?.resumeCommandPrefix ??
                        null
                      }
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
                <ScanStatusNotice visible={viewState.mode === "root"} />
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
