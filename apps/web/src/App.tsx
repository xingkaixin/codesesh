import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useMatches, useNavigate } from "react-router-dom";
import type { SessionHead } from "./lib/api";
import { logClientEvent } from "./lib/api";
import { getSessionRoutePath } from "./lib/session-indexes";
import { SessionAliasDialog } from "./components/SessionAliasDialog";
import { viewStateFromRouteMatches } from "./lib/view-state";
import { useScanStatusPublisher } from "./hooks/useScanStatus";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useSessionSearch } from "./hooks/useSessionSearch";
import { useBookmarks } from "./hooks/useBookmarks";
import { useSidebarModel } from "./hooks/useSidebarModel";
import { useSessionStore } from "./hooks/useSessionStore";
import { useAppConfig } from "./hooks/useAppConfig";
import { useProjectLookup } from "./hooks/useProjects";
import { useWindowLoadTelemetry } from "./hooks/useWindowLoadTelemetry";
import { useLiveSync } from "./hooks/useLiveSync";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTimeWindow } from "./hooks/useTimeWindow";
import { useUiPreferences } from "./hooks/useUiPreferences";
import { ResolvedThemeContext, useTheme } from "./hooks/useTheme";
import { buildRouteHeaderModel } from "./lib/build-route-header-model";
import { AppSidebar } from "./components/app/AppSidebar";
import type { SearchControlsHandle } from "./components/app/SearchControls";
import { ShortcutHelpDialog } from "./components/app/ShortcutHelpDialog";
import { AppRouteContent, type AppRouteModel } from "./components/app/AppRouteContent";
import { AppToolbar } from "./components/app/AppToolbar";
import { AppPageHeader } from "./components/app/AppPageHeader";
import { AppMainContent } from "./components/app/AppMainContent";
import { formatSearchSubtitle } from "./lib/scan-format";
import { findAgent } from "./lib/agents";
import { getProjectIdentityKey } from "./lib/projects";
import { buildSessionIndexes, getSessionAgentKey } from "./lib/session-indexes";
import { useCopySessionAsMarkdown } from "./hooks/useCopySessionAsMarkdown";
import { useSessionAliasDialog } from "./hooks/useSessionAliasDialog";

export default function App() {
  const navigate = useNavigate();
  const appConfig = useAppConfig();
  const timeWindowController = useTimeWindow(appConfig.config?.window);
  const { timeWindow } = timeWindowController;
  const sessionStore = useSessionStore(timeWindow);
  const {
    activeAgents,
    agentCatalog,
    sessions,
    sessionsLoading,
    sessionsError,
    projects,
    projectPage,
    projectsError,
    projectsLoading,
    dashboard,
    window: loadedWindow,
    validAgentKeys,
    agentNameMap,
    reload,
    applyLiveEvent,
    resyncLiveState,
    retryProjects,
    retrySessions,
  } = sessionStore;
  const loading = appConfig.loading || (!appConfig.error && sessionStore.loading);
  const error = appConfig.error ?? sessionStore.error;
  const retryLoad = appConfig.error ? appConfig.retry : sessionStore.retryLoad;
  useWindowLoadTelemetry({
    window: timeWindow,
    pending: appConfig.loading || (!appConfig.error && sessionStore.loadPending),
    error: error ?? sessionsError,
    agentCount: sessionStore.agents.length,
    sessionCount: sessionStore.sessions.length,
  });

  const location = useLocation();
  const setScanStatus = useScanStatusPublisher();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [mobileNavigationPath, setMobileNavigationPath] = useState<string | null>(null);
  const mobileNavigationOpen = mobileNavigationPath === location.pathname;
  const setMobileNavigationOpen = useCallback(
    (open: boolean) => setMobileNavigationPath(open ? location.pathname : null),
    [location.pathname],
  );
  const {
    shortcutHintDismissed,
    sidebarCollapsed,
    theme,
    dismissShortcutHint,
    setSidebarCollapsed,
    setTheme,
  } = useUiPreferences();
  const resolvedTheme = useTheme(theme);
  const { copySessionAsMarkdown, sessionCopyNotice } = useCopySessionAsMarkdown();

  const routeMatches = useMatches();
  const viewState = useMemo(
    () => viewStateFromRouteMatches(routeMatches, validAgentKeys),
    [routeMatches, validAgentKeys],
  );

  const sessionDetail = useSessionDetail(viewState);
  const { session, sessionError } = sessionDetail;

  useEffect(() => {
    logClientEvent("route.change", {
      mode: viewState.mode,
      agent: viewState.activeAgentKey,
      session: viewState.activeSessionId,
    });
  }, [location.pathname, viewState.mode, viewState.activeAgentKey, viewState.activeSessionId]);

  const sessionIndexes = useMemo(
    () => buildSessionIndexes(sessions, activeAgents),
    [sessions, activeAgents],
  );

  const search = useSessionSearch(sessionIndexes, loadedWindow);
  const searchControlsRef = useRef<SearchControlsHandle>(null);
  const {
    activeSearchQuery,
    searchMode,
    searchState,
    searchResults,
    searchLoading,
    selectedSearchIndex,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
  } = search;
  const openSearchAndFocus = useCallback(() => {
    openSearch();
    searchControlsRef.current?.focusAndSelect();
  }, [openSearch]);
  const clearSearchInput = useCallback(() => {
    searchControlsRef.current?.clear();
  }, []);
  const isSearchMode = searchMode;
  const detailHighlightQuery = isSearchMode
    ? activeSearchQuery
    : typeof location.state === "object" &&
        location.state !== null &&
        "searchQuery" in location.state &&
        typeof location.state.searchQuery === "string"
      ? location.state.searchQuery
      : "";

  const bookmarks = useBookmarks();
  const {
    bookmarkedSessions,
    loading: bookmarksLoading,
    error: bookmarksError,
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
  const activeProjectIdentity =
    activeProjectKind && activeProjectKey
      ? { kind: activeProjectKind, key: activeProjectKey }
      : null;
  const projectLookup = useProjectLookup(loadedWindow, activeProjectIdentity, projects);
  const resolvedProjects = useMemo(() => {
    if (!projectLookup.project || projects.includes(projectLookup.project)) return projects;
    return [...projects, projectLookup.project];
  }, [projectLookup.project, projects]);

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
    projects: resolvedProjects,
    selectedProjectAgent,
    isSessionBookmarked,
  });
  const {
    activeAgent,
    activeProject,
    activeProjectSessions,
    selectedProjectNavigation,
    sidebarSessions,
    bookmarkedSidebarSessionReferences,
  } = sidebar;
  const selectedProjectNavigationIdentity = selectedProjectNavigation?.identity ?? null;
  const selectedProjectNavigationId = selectedProjectNavigation?.identityKey ?? null;

  const handleSelectFlatSidebarSession = useCallback(
    (sessionItem: SessionHead) => {
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

  const { liveNotice } = useLiveSync({
    applyLiveEvent,
    resyncLiveState,
    setScanStatus,
  });

  const sessionAliases = useSessionAliasDialog(reload);

  const searchSubtitle =
    searchState.status === "failed"
      ? `Search failed for "${activeSearchQuery}"`
      : formatSearchSubtitle(activeSearchQuery, searchLoading, searchResults.length);

  const routeHeader = buildRouteHeaderModel({
    viewState,
    isSearchMode,
    searchSubtitle,
    dashboard,
    projectCount: projectPage.summary.projects,
    sessionCount: sessions.length,
    activeProject: activeProject?.project ?? null,
    activeAgent,
    sidebarSessionCount: sidebarSessions.length,
    session,
    sessionError: sessionError?.kind ?? null,
    selectedProjectIdentity: selectedProjectNavigationIdentity,
    selectedProject: selectedProjectNavigation?.project ?? null,
  });

  const overview = {
    window: loadedWindow,
    rangePreset: timeWindowController.preset ?? "all",
    onRangeChange: timeWindowController.selectPreset,
    onSelectCustom: timeWindowController.selectCustom,
  };
  const bookmarkActions = {
    isBookmarked: bookmarks.isSessionBookmarked,
    toggleSessionBookmark: bookmarks.toggleSessionBookmark,
  };
  let routeContent: AppRouteModel;
  switch (viewState.mode) {
    case "root":
      routeContent = {
        ...viewState,
        agentCatalog,
        projectCount: projectPage.summary.projects,
        overview,
      };
      break;
    case "projects":
      routeContent = {
        ...viewState,
        agentCatalog,
        projectPage,
        projectsLoad: {
          loading: projectsLoading,
          error: projectsError,
          retry: () => void retryProjects(),
        },
        window: loadedWindow,
      };
      break;
    case "project":
      routeContent = {
        ...viewState,
        agentCatalog,
        project: activeProject?.project ?? null,
        projectLoad: {
          loading: projectLookup.loading,
          error: projectLookup.error,
          retry: () => void projectLookup.retry(),
        },
        sessions: activeProjectSessions,
        agentFilter: {
          selectedAgent: selectedProjectAgent,
          onChangeAgent: selectProjectAgent,
        },
        overview,
      };
      break;
    case "agent":
      routeContent = {
        ...viewState,
        agents: activeAgents,
        agentCatalog,
        sessions: sessionIndexes.byLandingAgent.get(viewState.activeAgentKey) ?? [],
        bookmarks: bookmarkActions,
      };
      break;
    case "session":
      routeContent = {
        ...viewState,
        agents: activeAgents,
        agentCatalog,
        sessions: sessionIndexes.byLandingAgent.get(viewState.activeAgentKey) ?? [],
        bookmarks: bookmarkActions,
        detail: {
          session: sessionDetail.session,
          loading: sessionDetail.sessionLoading,
          error: sessionDetail.sessionError,
          retry: () => void sessionDetail.refresh(),
        },
        detailHighlightQuery,
        childSessionsByParentRouteKey: sessionIndexes.childrenByParentRouteKey,
      };
      break;
    case "missingAgent":
      routeContent = {
        ...viewState,
        agents: activeAgents,
        agentCatalog,
        sessions: sessionIndexes.landingSessions,
        bookmarks: bookmarkActions,
      };
      break;
    case "invalidRoute":
      routeContent = viewState;
      break;
  }

  const content = (
    <AppRouteContent
      load={{ loading, error, retry: () => void retryLoad() }}
      route={routeContent}
      search={{
        active: search.searchMode,
        query: search.activeSearchQuery,
        state: search.searchState,
        agentNameMap,
        agents: activeAgents,
        projectOptions: search.projectOptions,
        filters: search.searchFilters,
        onChangeFilters: search.setSearchFilters,
        onClose: search.closeSearch,
        onRetry: search.retrySearch,
        selectedIndex: search.selectedSearchIndex,
        registerResultRef: search.registerResultRef,
      }}
    />
  );

  useKeyboardShortcuts({
    viewState,
    navigate,
    selectedProjectNavigationIdentity,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    dismissShortcutHint,
    isSearchMode,
    activeSearchQuery,
    searchResults,
    selectedSearchIndex,
    setSelectedSearchIndex,
    clearSearchInput,
    openSearch: openSearchAndFocus,
    closeSearch,
  });

  const showShortcutHelp = useCallback(() => {
    setShortcutHelpOpen(true);
    dismissShortcutHint();
  }, [dismissShortcutHint]);
  const sessionRouteActive = !isSearchMode && viewState.mode === "session";
  const resumeSession =
    sessionRouteActive && session
      ? {
          resumeCommandPrefix:
            findAgent(agentCatalog, viewState.activeAgentKey)?.resumeCommandPrefix ?? null,
          sessionId: session.reference.sessionId,
          directory: session.directory,
        }
      : null;
  const sessionLoadNotice =
    !loading && !error && (sessionsLoading || sessionsError)
      ? { loading: sessionsLoading, error: sessionsError }
      : null;

  return (
    <ResolvedThemeContext.Provider value={resolvedTheme}>
      <div className="console-ui flex h-screen flex-col overflow-hidden bg-[var(--console-bg)] text-[var(--console-text)]">
        <a
          href="#main"
          className="console-mono sr-only rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-1.5 text-xs text-[var(--console-text)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
        >
          Skip to content
        </a>
        <AppToolbar
          searchControlsRef={searchControlsRef}
          onSubmitSearch={submitSearch}
          theme={theme}
          onChangeTheme={setTheme}
          onShowShortcuts={showShortcutHelp}
          timeWindow={
            timeWindow && timeWindowController.preset
              ? {
                  value: timeWindow,
                  preset: timeWindowController.preset,
                  customFrom: timeWindowController.customFrom,
                  customTo: timeWindowController.customTo,
                  onSelectPreset: timeWindowController.selectPreset,
                  onSelectCustom: timeWindowController.selectCustom,
                }
              : null
          }
        />

        <div className="flex min-h-0 flex-1">
          <AppSidebar
            model={{
              sidebarCollapsed,
              mobileNavigationOpen,
              viewState,
              agentCatalog,
              projects: resolvedProjects,
              projectCount: projectPage.summary.projects,
              projectsError,
              projectsLoading,
              selectedProjectNavigationId,
              bookmarkedSessions,
              bookmarksError,
              bookmarksLoading,
              sidebarSessions,
              sidebarSessionLookup: sidebar.sidebarSessionLookup,
              bookmarkedSidebarSessionReferences,
              isSearchMode,
              shortcutHelpOpen,
              dismissShortcutHint,
            }}
            actions={{
              onCollapse: () => setSidebarCollapsed(true),
              onMobileNavigationOpenChange: setMobileNavigationOpen,
              onToggleBookmark: toggleBookmark,
              onSelectFlatSidebarSession: handleSelectFlatSidebarSession,
              onCopySessionAsMarkdown: (sessionHead) => void copySessionAsMarkdown(sessionHead),
              onToggleSidebarSessionBookmark: handleToggleSidebarSessionBookmark,
              onRenameSession: sessionAliases.openSession,
              onRenameBookmarkedSession: sessionAliases.openBookmark,
              onRetryProjects: () => void retryProjects(),
              onRetryBookmarks: () => void refreshBookmarks(),
            }}
          />

          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            <AppPageHeader
              model={{
                mobileNavigationOpen,
                sidebarCollapsed,
                route: routeHeader,
                shortcutHintVisible: !shortcutHintDismissed,
                sessionBackHintVisible: sessionRouteActive,
                resumeSession,
                sessionCopyNotice,
                liveNotice,
                scanStatusVisible: viewState.mode === "root",
                sessionLoadNotice,
              }}
              actions={{
                onOpenMobileNavigation: () => setMobileNavigationOpen(true),
                onExpandSidebar: () => setSidebarCollapsed(false),
                onDismissShortcutHint: dismissShortcutHint,
                onRetrySessionLoad: () => void retrySessions(),
              }}
            />
            <AppMainContent
              locationPath={location.pathname}
              mode={viewState.mode}
              searchActive={isSearchMode}
              sessionCount={sessions.length}
            >
              {content}
            </AppMainContent>
          </main>
        </div>
        <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
        <SessionAliasDialog
          target={sessionAliases.target}
          onClose={sessionAliases.close}
          onSave={sessionAliases.save}
          onRemove={sessionAliases.remove}
        />
      </div>
    </ResolvedThemeContext.Provider>
  );
}
