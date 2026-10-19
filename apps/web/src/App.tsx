import { useLocale } from "./hooks/useLocale";
import { t } from "./i18n/translate";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useMatches, useNavigate } from "react-router-dom";
import type { SessionHead } from "@codesesh/contract";
import { logClientEvent } from "./lib/api";
import { getSessionRoutePath } from "./lib/session-indexes";
import { SessionAliasDialog } from "./components/SessionAliasDialog";
import { viewStateFromRouteMatches } from "./lib/view-state";
import { useScanStatusPublisher } from "./hooks/useScanStatus";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useSessionSearch } from "./hooks/useSessionSearch";
import { useBookmarks } from "./hooks/useBookmarks";
import { useSidebarModel } from "./hooks/useSidebarModel";
import { useNodes } from "./hooks/useNodes";
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
import { AppPageHeader, AppPageHero } from "./components/app/AppPageHeader";
import { AppToasts } from "./components/app/AppToasts";
import { SessionHeaderActions } from "./components/app/SessionHeaderActions";
import { TimeRangeControl } from "./components/app/TimeRangeControl";
import { sourceName } from "./components/nodes/SourceBadge";
import { AppMainContent } from "./components/app/AppMainContent";
import { findAgent } from "./lib/agents";
import { getProjectIdentityKey, getProjectPath } from "./lib/projects";
import { agentRoutePath, buildSessionIndexes, getSessionAgentKey } from "./lib/session-indexes";
import { useCopySessionAsMarkdown } from "./hooks/useCopySessionAsMarkdown";
import { useSessionAliasDialog } from "./hooks/useSessionAliasDialog";
import { APP_ROUTE_IDS } from "./lib/app-routes";

const ScanStatusNotice = lazy(() =>
  import("./components/app/ScanStatusNotice").then((module) => ({
    default: module.ScanStatusNotice,
  })),
);
const SessionSourceDetails = lazy(() =>
  import("./components/nodes/SessionSourceDetails").then((module) => ({
    default: module.SessionSourceDetails,
  })),
);

export default function App() {
  useLocale();

  const navigate = useNavigate();
  const appConfig = useAppConfig();
  const timeWindowController = useTimeWindow(appConfig.config?.window);
  const { timeWindow } = timeWindowController;
  const routeMatches = useMatches();
  const sessionStore = useSessionStore(timeWindow, routeMatches.at(-1)?.id === APP_ROUTE_IDS.root);
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

  const location = useLocation();
  const setScanStatus = useScanStatusPublisher();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [mobileNavigationPath, setMobileNavigationPath] = useState<string | null>(null);
  const mobileNavigationOpen = mobileNavigationPath === location.pathname;
  const setMobileNavigationOpen = useCallback(
    (open: boolean) => setMobileNavigationPath(open ? location.pathname : null),
    [location.pathname],
  );
  const { sidebarCollapsed, theme, setSidebarCollapsed, setTheme } = useUiPreferences();
  const resolvedTheme = useTheme(theme);
  const { copySessionAsMarkdown, sessionCopyNotice } = useCopySessionAsMarkdown();

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
  useWindowLoadTelemetry({
    window: timeWindow,
    pending:
      appConfig.loading || (!appConfig.error && (sessionStore.loadPending || bookmarksLoading)),
    error: error ?? sessionsError ?? sessionStore.loadError ?? bookmarksError,
    agentCount: sessionStore.agents.length,
    sessionCount: sessionStore.sessions.length,
  });

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
  const sourceNodes = useNodes();
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

  const sessionSourceNodeId =
    viewState.mode === "session" && session ? (session.reference.sourceNodeId ?? "local") : null;
  const routeHeader = buildRouteHeaderModel({
    viewState,
    isSearchMode,
    searchResultCount:
      searchState.status === "loaded" && !searchLoading ? searchResults.length : null,
    projectCount: projectPage.summary.projects,
    activeProject: activeProject?.project ?? null,
    activeAgent,
    sidebarSessionCount: sidebarSessions.length,
    session,
    sessionError: sessionError?.kind ?? null,
    sessionSourceLabel: sessionSourceNodeId
      ? sourceName(sessionSourceNodeId, sourceNodes.data?.nodes)
      : null,
    selectedProjectIdentity: selectedProjectNavigationIdentity,
    selectedProject: selectedProjectNavigation?.project ?? null,
  });

  const overview = {
    window: loadedWindow,
    rangePreset: timeWindowController.preset ?? "all",
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
          messagePaging: sessionDetail.messagePaging,
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
        controls: searchControlsRef,
        onSubmit: submitSearch,
      }}
    />
  );

  useKeyboardShortcuts({
    viewState,
    navigate,
    selectedProjectNavigationIdentity,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    isSearchMode,
    activeSearchQuery,
    searchResults,
    selectedSearchIndex,
    setSelectedSearchIndex,
    clearSearchInput,
    openSearch: openSearchAndFocus,
    closeSearch,
  });

  const showShortcutHelp = useCallback(() => setShortcutHelpOpen(true), []);
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
  const sessionBack =
    sessionRouteActive && viewState.activeAgentKey
      ? selectedProjectNavigationIdentity
        ? { to: getProjectPath(selectedProjectNavigationIdentity), label: t("Back to project") }
        : { to: agentRoutePath(viewState.activeAgentKey), label: t("Back to sessions") }
      : null;
  const sessionLoadNotice =
    !loading && !error && (sessionsLoading || sessionsError)
      ? { loading: sessionsLoading, error: sessionsError }
      : null;
  const resumeDescriptionId = useId();

  let headerActions: ReactNode = null;
  if (sessionRouteActive && session && resumeSession) {
    const agentKey = viewState.activeAgentKey;
    headerActions = (
      <SessionHeaderActions
        back={sessionBack}
        bookmarked={isSessionBookmarked(
          agentKey,
          session.reference.sessionId,
          session.reference.sourceNodeId,
        )}
        onToggleBookmark={() => toggleSessionBookmark(session, agentKey)}
        onRename={() => sessionAliases.openSession(session)}
        onCopyAsMarkdown={() => void copySessionAsMarkdown(session)}
        resume={resumeSession}
        resumeDescriptionId={resumeDescriptionId}
      />
    );
  } else if (!sessionRouteActive && timeWindow && timeWindowController.preset) {
    headerActions = (
      <>
        <TimeRangeControl
          window={timeWindow}
          preset={timeWindowController.preset}
          customFrom={timeWindowController.customFrom}
          customTo={timeWindowController.customTo}
          onSelectPreset={timeWindowController.selectPreset}
          onSelectCustom={timeWindowController.selectCustom}
        />
        {viewState.mode === "root" && !isSearchMode ? (
          <button
            type="button"
            onClick={showShortcutHelp}
            className="hidden h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-sidebar-accent)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none sm:inline-flex"
          >
            <kbd className="inline-flex h-[18px] items-center rounded-[4px] border border-b-2 border-[var(--console-border)] bg-[var(--console-surface)] px-[5px] text-[10px] font-semibold text-[var(--console-muted)]">
              ?
            </kbd>
            {t("Shortcuts")}
          </button>
        ) : null}
      </>
    );
  }

  const scanStatusVisible =
    appConfig.config != null &&
    !appConfig.config.hubEnabled &&
    (viewState.mode === "root" || isSearchMode);
  const intro = (
    <>
      {routeHeader.hero ? (
        <AppPageHero hero={routeHeader.hero}>
          {sessionSourceNodeId ? (
            <Suspense fallback={null}>
              <SessionSourceDetails
                sourceNodeId={sessionSourceNodeId}
                canResume={Boolean(resumeSession?.resumeCommandPrefix)}
                resumeDescriptionId={resumeDescriptionId}
              />
            </Suspense>
          ) : null}
        </AppPageHero>
      ) : null}
      {scanStatusVisible ? (
        <Suspense fallback={null}>
          <ScanStatusNotice visible />
        </Suspense>
      ) : null}
      {sessionLoadNotice ? (
        <div
          role={sessionLoadNotice.error ? "alert" : "status"}
          className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-3 py-2 text-xs text-[var(--console-warning)]"
        >
          <span>
            {sessionLoadNotice.error ?? t("Loading sessions… Results are not yet complete.")}
          </span>
          {sessionLoadNotice.error ? (
            <button
              type="button"
              disabled={sessionLoadNotice.loading}
              onClick={() => void retrySessions()}
              className="rounded-md border border-current px-2 py-0.5 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
            >
              {t("Retry session load")}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const hasIntro = Boolean(routeHeader.hero || scanStatusVisible || sessionLoadNotice);

  return (
    <ResolvedThemeContext.Provider value={resolvedTheme}>
      <div className="console-ui flex h-screen overflow-hidden bg-[var(--console-sidebar-bg)] text-[var(--console-text)]">
        <a
          href="#main"
          className="sr-only rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-1.5 text-xs text-[var(--console-text)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
        >
          {t("Skip to content")}
        </a>
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
            sourceNodes: sourceNodes.data?.nodes,
            isSearchMode,
            shortcutHelpOpen,
            hubEnabled: Boolean(appConfig.config?.hubEnabled),
            sessionCount: sessions.length,
            theme,
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
            onOpenSearch: () => {
              setMobileNavigationOpen(false);
              openSearchAndFocus();
            },
            onChangeTheme: setTheme,
            onShowShortcuts: showShortcutHelp,
          }}
        />

        <main
          id="main"
          tabIndex={-1}
          className="my-2 mr-2 ml-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--console-border)] bg-[var(--console-bg)] outline-none min-[1025px]:ml-0"
        >
          <AppPageHeader
            route={routeHeader}
            mobileNavigationOpen={mobileNavigationOpen}
            sidebarCollapsed={sidebarCollapsed}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            actions={headerActions}
          />
          <AppMainContent
            locationPath={location.pathname}
            mode={viewState.mode}
            searchActive={isSearchMode}
            sessionCount={sessions.length}
            intro={hasIntro ? intro : undefined}
          >
            {content}
          </AppMainContent>
        </main>
        <AppToasts messages={[sessionCopyNotice, liveNotice]} />
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
