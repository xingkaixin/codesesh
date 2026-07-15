declare const __APP_VERSION__: string;

import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { BookmarkedSessionSnapshot, SessionHead } from "./lib/api";
import { deleteSessionAlias, logClientEvent, upsertSessionAlias } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CopyResumeButton } from "./components/CopyResumeButton";
import { SessionAliasDialog, type SessionAliasTarget } from "./components/SessionAliasDialog";
import { TimeWindowControl } from "./components/TimeWindowControl";
import { RenderProfiler } from "./components/RenderProfiler";
import { parseViewState } from "./lib/view-state";
import { useScanStatus } from "./hooks/useScanStatus";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useSessionSearch } from "./hooks/useSessionSearch";
import { useBookmarks } from "./hooks/useBookmarks";
import { useDashboard } from "./hooks/useDashboard";
import { useProjectDashboard } from "./hooks/useProjectDashboard";
import { useAppConfig } from "./hooks/useAppConfig";
import { useAgents } from "./hooks/useAgents";
import { useSessions } from "./hooks/useSessions";
import { useProjects } from "./hooks/useProjects";
import { useInitialLoad } from "./hooks/useInitialLoad";
import { useLiveSync } from "./hooks/useLiveSync";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTimeWindow } from "./hooks/useTimeWindow";
import { buildRouteHeaderModel } from "./lib/build-route-header-model";
import { AppSidebar } from "./components/app/AppSidebar";
import { ShortcutHelpDialog } from "./components/app/ShortcutHelpDialog";
import { AppRouteContent } from "./components/app/AppRouteContent";
import type { BrowseBy } from "./components/app/types";
import { formatScanStatusLabel, formatSearchSubtitle } from "./lib/scan-format";
import {
  getProjectGroupIdentity,
  getProjectIdentityKey,
  getProjectPath,
  type ProjectRouteIdentity,
} from "./lib/projects";
import {
  buildSessionIndexes,
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionRouteKey,
} from "./lib/session-indexes";

const SHORTCUT_HINT_STORAGE_KEY = "codesesh.shortcuts-hint-dismissed";

export default function App() {
  const navigate = useNavigate();
  const { appConfig, refresh: refreshAppConfig } = useAppConfig();
  const timeWindowController = useTimeWindow(appConfig?.window);
  const { timeWindow } = timeWindowController;
  const { agents, validAgentKeys, agentNameMap, refresh: refreshAgents } = useAgents();
  const { sessions, refresh: refreshSessions } = useSessions();
  const { projects, refresh: refreshProjects } = useProjects();
  const { loading, error } = useInitialLoad({
    refreshAppConfig,
    refreshAgents,
    refreshSessions,
    refreshProjects,
    resolveWindow: timeWindowController.resolve,
  });

  const [browseBy, setBrowseBy] = useState<BrowseBy>("agents");
  const [selectedProjectIdentity, setSelectedProjectIdentity] =
    useState<ProjectRouteIdentity | null>(null);
  const { scanStatus, setScanStatus } = useScanStatus();
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutHintDismissed, setShortcutHintDismissed] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aliasTarget, setAliasTarget] = useState<SessionAliasTarget | null>(null);

  const location = useLocation();
  const viewState = useMemo(
    () => parseViewState(location.pathname, validAgentKeys),
    [location.pathname, validAgentKeys],
  );

  const sessionDetail = useSessionDetail(viewState);
  const { session, sessionError, refresh: refreshSessionDetail } = sessionDetail;

  useEffect(() => {
    logClientEvent("route.change", {
      path: location.pathname,
      mode: viewState.mode,
      agent: viewState.activeAgentKey,
      session: viewState.activeSessionSlug,
    });
  }, [location.pathname, viewState.mode, viewState.activeAgentKey, viewState.activeSessionSlug]);

  useEffect(() => {
    if (viewState.mode === "projects" || viewState.mode === "project") {
      setBrowseBy("projects");
      if (viewState.mode === "project") {
        setSelectedProjectIdentity({
          kind: viewState.activeProjectKind,
          key: viewState.activeProjectKey,
        });
      }
      return;
    }
    if (viewState.mode === "agent" || viewState.mode === "missingAgent") {
      setBrowseBy("agents");
    }
  }, [viewState]);
  const sessionIndexes = useMemo(() => buildSessionIndexes(sessions, agents), [sessions, agents]);

  const search = useSessionSearch(sessionIndexes, timeWindow);
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
    refresh: refreshSearch,
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
  const { bookmarkedSessions, isSessionBookmarked, toggleBookmark, toggleSessionBookmark } =
    bookmarks;

  const activeAgentKey = viewState.activeAgentKey;
  const activeProjectKind = viewState.mode === "project" ? viewState.activeProjectKind : null;
  const activeProjectKey = viewState.mode === "project" ? viewState.activeProjectKey : null;
  const activeProjectIdentity = useMemo<ProjectRouteIdentity | null>(
    () =>
      activeProjectKind && activeProjectKey
        ? { kind: activeProjectKind, key: activeProjectKey }
        : null,
    [activeProjectKind, activeProjectKey],
  );
  const activeProjectIdentityKey = activeProjectIdentity
    ? getProjectIdentityKey(activeProjectIdentity)
    : null;

  const { dashboard, refresh: refreshDashboard } = useDashboard(timeWindow);
  const projectController = useProjectDashboard(
    timeWindow,
    activeProjectKind,
    activeProjectKey,
    activeProjectIdentityKey,
  );
  const { selectedProjectAgent, refresh: refreshProjectDashboard } = projectController;

  const openedSessionHead = useMemo(() => {
    if (viewState.mode !== "session") return null;
    return (
      sessionIndexes.byRouteKey.get(
        getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionSlug),
      ) ?? null
    );
  }, [sessionIndexes, viewState]);
  const openedSessionData =
    viewState.mode === "session" && session?.id === viewState.activeSessionSlug ? session : null;
  const openedSessionProjectIdentity =
    openedSessionData?.project_identity ?? openedSessionHead?.project_identity ?? null;
  const selectedProjectNavigationIdentity =
    browseBy !== "projects"
      ? null
      : viewState.mode === "project"
        ? activeProjectIdentity
        : viewState.mode === "session"
          ? openedSessionProjectIdentity
          : null;
  const selectedProjectNavigationId = selectedProjectNavigationIdentity
    ? getProjectIdentityKey(selectedProjectNavigationIdentity)
    : null;
  const agentSidebarSessions = useMemo(
    () => (activeAgentKey ? (sessionIndexes.byAgent.get(activeAgentKey) ?? []) : []),
    [activeAgentKey, sessionIndexes],
  );
  const projectSidebarSessions = useMemo(() => {
    if (!selectedProjectNavigationId) return [];
    if (selectedProjectAgent) {
      return (
        sessionIndexes.byProjectAgentKey.get(
          getProjectAgentKey(selectedProjectNavigationId, selectedProjectAgent),
        ) ?? []
      );
    }
    return sessionIndexes.byProjectIdentityKey.get(selectedProjectNavigationId) ?? [];
  }, [selectedProjectAgent, selectedProjectNavigationId, sessionIndexes]);
  const sidebarSessions = browseBy === "projects" ? projectSidebarSessions : agentSidebarSessions;
  const sidebarSessionLookup = useMemo(
    () => buildSidebarSessionLookup(sidebarSessions),
    [sidebarSessions],
  );
  const bookmarkedSidebarSessionIds = useMemo(() => {
    if (sidebarSessions.length === 0) return new Set<string>();
    return new Set(
      sidebarSessions
        .filter((sessionItem) =>
          isSessionBookmarked(getSessionAgentKey(sessionItem), sessionItem.id),
        )
        .map((sessionItem) => sessionItem.id),
    );
  }, [isSessionBookmarked, sidebarSessions]);

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

  const scanStatusLabel = formatScanStatusLabel(scanStatus);
  const isScanActive = scanStatus?.active === true;

  const { liveNotice } = useLiveSync({
    timeWindow,
    viewState,
    refreshAgents,
    refreshSessions,
    refreshProjects,
    refreshDashboard,
    refreshProjectDashboard,
    refreshSessionDetail,
    refreshSearch,
    setScanStatus,
  });

  const refreshAliasViews = useCallback(async () => {
    await Promise.all([
      timeWindow ? refreshSessions(timeWindow) : Promise.resolve(),
      refreshDashboard(),
      refreshProjectDashboard(),
      refreshSessionDetail(),
      refreshSearch(),
      bookmarks.refresh(),
    ]);
  }, [
    timeWindow,
    bookmarks,
    refreshDashboard,
    refreshProjectDashboard,
    refreshSearch,
    refreshSessionDetail,
    refreshSessions,
  ]);

  const saveSessionAlias = useCallback(
    async (alias: string) => {
      if (!aliasTarget) return;
      await upsertSessionAlias(aliasTarget.agentKey, aliasTarget.sessionId, alias);
      await refreshAliasViews();
    },
    [aliasTarget, refreshAliasViews],
  );

  const removeSessionAlias = useCallback(async () => {
    if (!aliasTarget) return;
    await deleteSessionAlias(aliasTarget.agentKey, aliasTarget.sessionId);
    await refreshAliasViews();
  }, [aliasTarget, refreshAliasViews]);

  useEffect(() => {
    try {
      setShortcutHintDismissed(window.localStorage.getItem(SHORTCUT_HINT_STORAGE_KEY) === "1");
    } catch {
      setShortcutHintDismissed(true);
    }
  }, []);

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

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.name.toLowerCase() === activeAgentKey) ?? null,
    [activeAgentKey, agents],
  );
  const activeProject = useMemo(
    () =>
      projects.find(
        (project) =>
          activeProjectIdentityKey === getProjectIdentityKey(getProjectGroupIdentity(project)),
      ) ?? null,
    [activeProjectIdentityKey, projects],
  );
  const selectedProjectNavigation = useMemo(
    () =>
      projects.find(
        (project) =>
          selectedProjectNavigationId === getProjectIdentityKey(getProjectGroupIdentity(project)),
      ) ?? null,
    [projects, selectedProjectNavigationId],
  );

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
    activeProject,
    activeAgent,
    sidebarSessionCount: sidebarSessions.length,
    session,
    sessionError,
    selectedProjectIdentity: selectedProjectNavigationIdentity,
    selectedProject: selectedProjectNavigation,
  });

  const content = (
    <AppRouteContent
      loading={loading}
      error={error}
      viewState={viewState}
      detailHighlightQuery={detailHighlightQuery}
      agents={agents}
      agentNameMap={agentNameMap}
      projects={projects}
      sessionIndexes={sessionIndexes}
      dashboard={dashboard}
      sessionDetail={sessionDetail}
      projectController={projectController}
      search={search}
      bookmarks={bookmarks}
    />
  );

  function dismissShortcutHint() {
    setShortcutHintDismissed(true);
    try {
      window.localStorage.setItem(SHORTCUT_HINT_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures and keep the UI usable.
    }
  }

  function changeBrowseBy(next: BrowseBy) {
    if (next === "projects" && isScanActive) return;
    setBrowseBy(next);
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
    <div className="console-ui flex h-screen flex-col overflow-hidden bg-[var(--console-bg)] text-[var(--console-text)]">
      <header className="shrink-0 border-b border-[var(--console-border)] bg-white/85 backdrop-blur-sm">
        <div className="grid min-h-14 grid-cols-[auto_1fr] items-center gap-3 px-4 py-2 sm:grid-cols-[auto_1fr_auto] sm:py-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="hidden rounded-sm border border-[var(--console-border)] bg-white p-1.5 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] lg:inline-flex"
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
            <label className="flex min-w-0 flex-1 items-center rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 focus-within:border-[var(--console-border-strong)] focus-within:ring-2 focus-within:ring-[var(--console-accent)] focus-within:ring-offset-2">
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
              className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-3 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-white focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Search
            </button>
          </form>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShortcutHelpOpen(true);
                dismissShortcutHint();
              }}
              className="console-mono rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
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
            agents,
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

        <main className="flex min-w-0 flex-1 flex-col">
          <section className="shrink-0 border-b border-[var(--console-border)] bg-white/70 px-4 py-4 backdrop-blur-sm md:px-8">
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
                        className="transition-colors hover:text-[var(--console-text)]"
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
                    <span className="rounded-sm border border-[var(--console-border)] bg-white px-1">
                      ?
                    </span>
                    <button
                      type="button"
                      onClick={dismissShortcutHint}
                      className="text-[var(--console-muted)] transition-colors hover:text-[var(--console-text)]"
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
              {liveNotice ? (
                <p className="console-mono mt-2 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
                  {liveNotice}
                </p>
              ) : null}
              {scanStatusLabel && viewState.mode === "root" ? (
                <p className="console-mono mt-2 inline-flex max-w-4xl rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--console-warning)]">
                  {scanStatusLabel}
                </p>
              ) : null}
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
  );
}
