declare const __APP_VERSION__: string;

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { SessionHead } from "./lib/api";
import { logClientEvent } from "./lib/api";
import { SessionDetail } from "./components/SessionDetail";
import { SessionDetailSkeleton } from "./components/SessionDetailSkeleton";
import { DetailLanding, type LandingAgentItem } from "./components/DetailLanding";
import { Dashboard } from "./components/Dashboard";
import { ProjectDashboardView, ProjectsOverview } from "./components/Projects";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CopyResumeButton } from "./components/CopyResumeButton";
import { RenderProfiler } from "./components/RenderProfiler";
import { SmartTagChips } from "./components/SmartTagChips";
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
import { AppSidebar } from "./components/app/AppSidebar";
import { SearchResultsPanel } from "./components/app/SearchResultsPanel";
import { ShortcutHelpDialog } from "./components/app/ShortcutHelpDialog";
import { type BrowseBy, type SearchProjectOption } from "./components/app/types";
import { formatScanStatusLabel, formatSearchSubtitle, formatWindowLabel } from "./lib/scan-format";
import { formatRelativeTime } from "./lib/format";
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

interface BreadcrumbItem {
  label: string;
  to?: string;
}

const SHORTCUT_HINT_STORAGE_KEY = "codesesh.shortcuts-hint-dismissed";

export default function App() {
  const navigate = useNavigate();
  const { appConfig, refresh: refreshAppConfig } = useAppConfig();
  const { agents, validAgentKeys, agentNameMap, refresh: refreshAgents } = useAgents();
  const {
    sessions,
    refresh: refreshSessions,
    applyLiveEvent: applySessionsLiveEvent,
  } = useSessions();
  const { projects, refresh: refreshProjects } = useProjects();
  const { loading, error } = useInitialLoad({
    refreshAppConfig,
    refreshAgents,
    refreshSessions,
    refreshProjects,
  });

  const [browseBy, setBrowseBy] = useState<BrowseBy>("agents");
  const [selectedProjectIdentity, setSelectedProjectIdentity] =
    useState<ProjectRouteIdentity | null>(null);
  const { scanStatus, setScanStatus } = useScanStatus();
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutHintDismissed, setShortcutHintDismissed] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const location = useLocation();
  const viewState = useMemo(
    () => parseViewState(location.pathname, validAgentKeys),
    [location.pathname, validAgentKeys],
  );

  const {
    session,
    sessionLoading,
    sessionError,
    refresh: refreshSessionDetail,
  } = useSessionDetail(viewState);

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

  const {
    draftSearchQuery,
    activeSearchQuery,
    searchMode,
    searchFilters,
    searchResults,
    searchLoading,
    usesServerSearch,
    selectedSearchIndex,
    searchInputRef,
    searchResultRefs,
    setDraftSearchQuery,
    setSearchFilters,
    setSelectedSearchIndex,
    openSearch,
    submitSearch,
    closeSearch,
    refresh: refreshSearch,
  } = useSessionSearch(sessionIndexes);
  const isSearchMode = searchMode;
  const detailHighlightQuery = isSearchMode
    ? activeSearchQuery
    : typeof location.state === "object" &&
        location.state !== null &&
        "searchQuery" in location.state &&
        typeof location.state.searchQuery === "string"
      ? location.state.searchQuery
      : "";

  const { bookmarkedSessions, isSessionBookmarked, toggleBookmark, toggleSessionBookmark } =
    useBookmarks(sessions);

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

  const { dashboard, refresh: refreshDashboard } = useDashboard(appConfig);
  const {
    projectDashboard,
    projectDashboardLoading,
    projectDashboardError,
    selectedProjectAgent,
    setSelectedProjectAgent,
    refresh: refreshProjectDashboard,
  } = useProjectDashboard(appConfig, activeProjectKind, activeProjectKey, activeProjectIdentityKey);

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
    browseBy === "projects"
      ? (activeProjectIdentity ??
        (viewState.mode === "session" ? openedSessionProjectIdentity : selectedProjectIdentity))
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
    appConfig,
    viewState,
    applySessionsLiveEvent,
    refreshAgents,
    refreshSessions,
    refreshProjects,
    refreshDashboard,
    refreshProjectDashboard,
    refreshSessionDetail,
    refreshSearch,
    setScanStatus,
  });

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

  // Build landing data
  const landingSessions = sessionIndexes.landingSessions;
  const activeProjectSessions = useMemo(
    () =>
      activeProjectIdentityKey
        ? (sessionIndexes.byLandingProjectIdentityKey.get(activeProjectIdentityKey) ?? [])
        : [],
    [activeProjectIdentityKey, sessionIndexes],
  );

  const landingAgentItems = useMemo<LandingAgentItem[]>(() => {
    return agents
      .filter((a) => a.count > 0)
      .map((a) => ({
        key: a.name.toLowerCase(),
        name: a.displayName,
        icon: a.icon,
        count: a.count,
      }));
  }, [agents]);

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

  const projectOptions = sessionIndexes.projectOptions;
  const searchProjectOptions = useMemo<SearchProjectOption[]>(() => {
    if (!usesServerSearch) return projectOptions;

    const byKey = new Map<string, SearchProjectOption>();
    const sourceResults = searchLoading ? [] : searchResults;

    for (const result of sourceResults) {
      const identity = result.session.project_identity;
      if (!identity?.key) continue;
      const projectIdentityKey = getProjectIdentityKey(identity);
      const current = byKey.get(projectIdentityKey);
      if (current) {
        current.count += 1;
      } else {
        byKey.set(projectIdentityKey, {
          key: projectIdentityKey,
          identityKind: identity.kind,
          identityKey: identity.key,
          label: identity.displayName || result.session.directory,
          count: 1,
          showCount: false,
        });
      }
    }

    const selectedProjectKey = searchFilters.project
      ? getProjectIdentityKey(searchFilters.project)
      : undefined;
    if (selectedProjectKey && !byKey.has(selectedProjectKey)) {
      const selected = projectOptions.find((project) => project.key === selectedProjectKey);
      if (selected) {
        byKey.set(selected.key, { ...selected, count: 0, showCount: false });
      }
    }

    return [...byKey.values()].toSorted((a, b) => b.count - a.count).slice(0, 8);
  }, [projectOptions, searchFilters.project, searchLoading, searchResults, usesServerSearch]);

  // Header
  let headerTitle = "CodeSesh";
  let headerSubtitle: ReactNode = "Select an agent to browse sessions";
  if (viewState.mode === "root") {
    headerTitle = isSearchMode ? "Search" : "Dashboard";
    headerSubtitle = isSearchMode
      ? formatSearchSubtitle(activeSearchQuery, searchLoading, searchResults.length)
      : dashboard
        ? `${dashboard.totals.sessions.toLocaleString("en-US")} total sessions across ${dashboard.perAgent.length} agents`
        : "Aggregated view across all agents";
  }
  if (viewState.mode === "projects") {
    headerTitle = "Projects";
    headerSubtitle = `${projects.length.toLocaleString("en-US")} projects across ${sessions.length.toLocaleString("en-US")} sessions`;
  }
  if (viewState.mode === "project") {
    headerTitle = activeProject?.displayName ?? "Project";
    headerSubtitle = activeProject
      ? `${activeProject.sessionCount.toLocaleString("en-US")} sessions · ${activeProject.agentStats.length} agents`
      : viewState.activeProjectKey;
  }
  if (viewState.mode === "agent" && activeAgentKey) {
    headerTitle = activeAgent?.displayName ?? activeAgentKey;
    headerSubtitle = `${sidebarSessions.length} sessions`;
  }
  if (viewState.mode === "session") {
    if (sessionError) {
      headerTitle = "Session Not Found";
      headerSubtitle = `Requested /${activeAgentKey}/${viewState.activeSessionSlug}`;
    } else if (session) {
      headerTitle = session.title || "Conversation";
      const updated = session.time_updated ?? session.time_created;
      headerSubtitle = (
        <>
          <span>ID: #{session.id.slice(0, 8)}</span>
          <span>·</span>
          <span>Updated {formatRelativeTime(updated)}</span>
          <SmartTagChips tags={session.smart_tags} limit={9} className="inline-flex" />
        </>
      );
    }
  }
  if (viewState.mode === "missingAgent") {
    headerTitle = "Agent Not Found";
    headerSubtitle = `Requested /${viewState.attemptedKey}`;
  }
  if (viewState.mode === "missingSession") {
    headerTitle = "Session Not Found";
    headerSubtitle = `Session not found in /${activeAgentKey}`;
  }
  if (isSearchMode) {
    headerTitle = "Search";
    headerSubtitle = formatSearchSubtitle(activeSearchQuery, searchLoading, searchResults.length);
  }

  const breadcrumbItems = useMemo<BreadcrumbItem[]>(() => {
    if (isSearchMode) {
      return [{ label: "Search" }];
    }

    const dashboardCrumb: BreadcrumbItem = {
      label: "Dashboard",
      to:
        (browseBy === "agents" && viewState.mode === "root") ||
        (browseBy === "projects" && viewState.mode === "projects")
          ? undefined
          : browseBy === "projects"
            ? "/projects"
            : "/",
    };

    if (viewState.mode === "root") {
      return [{ label: "Dashboard" }];
    }

    const projectsCrumb: BreadcrumbItem = {
      label: "Projects",
      to: viewState.mode === "project" ? "/projects" : undefined,
    };

    if (viewState.mode === "projects") {
      return [dashboardCrumb, { label: "Projects" }];
    }

    if (viewState.mode === "project") {
      return [
        dashboardCrumb,
        projectsCrumb,
        { label: activeProject?.displayName ?? viewState.activeProjectKey },
      ];
    }

    if (
      viewState.mode === "session" &&
      browseBy === "projects" &&
      selectedProjectNavigationIdentity
    ) {
      return [
        dashboardCrumb,
        { label: "Projects", to: "/projects" },
        {
          label: selectedProjectNavigation?.displayName ?? selectedProjectNavigationIdentity.key,
          to: getProjectPath(selectedProjectNavigationIdentity),
        },
        { label: session?.title || viewState.activeSessionSlug || "Conversation" },
      ];
    }

    if (viewState.mode === "missingAgent") {
      return [dashboardCrumb, { label: viewState.attemptedKey }];
    }

    const agentLabel = activeAgent?.displayName ?? activeAgentKey ?? "Unknown Agent";
    const agentCrumb: BreadcrumbItem = {
      label: agentLabel,
      to: viewState.mode === "session" ? `/${activeAgentKey}` : undefined,
    };

    if (viewState.mode === "agent") {
      return [dashboardCrumb, { label: agentLabel }];
    }

    if (viewState.mode === "missingSession") {
      return [dashboardCrumb, agentCrumb, { label: viewState.attemptedSessionSlug }];
    }

    if (viewState.mode === "session") {
      return [
        dashboardCrumb,
        agentCrumb,
        { label: session?.title || viewState.activeSessionSlug || "Conversation" },
      ];
    }

    return [dashboardCrumb, { label: "Invalid Route" }];
  }, [
    activeAgent,
    activeAgentKey,
    activeProject,
    browseBy,
    isSearchMode,
    selectedProjectNavigation,
    selectedProjectNavigationIdentity,
    session?.title,
    viewState,
  ]);

  // Content
  let content: ReactNode;
  if (loading) {
    content = <SessionDetailSkeleton />;
  } else if (isSearchMode) {
    content = (
      <RenderProfiler
        id="SearchResultsPanel"
        detail={{ results: searchResults.length, loading: searchLoading }}
      >
        <SearchResultsPanel
          query={activeSearchQuery}
          loading={searchLoading}
          results={searchResults}
          agentNameMap={agentNameMap}
          agents={agents}
          projects={searchProjectOptions}
          filters={searchFilters}
          onChangeFilters={setSearchFilters}
          onOpenResult={closeSearch}
          selectedIndex={selectedSearchIndex}
          registerResultRef={(key, node) => {
            if (node) searchResultRefs.current.set(key, node);
            else searchResultRefs.current.delete(key);
          }}
        />
      </RenderProfiler>
    );
  } else if (error) {
    content = (
      <div className="mx-auto max-w-4xl rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]">
        {error}
      </div>
    );
  } else if (viewState.mode === "root") {
    content = dashboard ? (
      <RenderProfiler
        id="Dashboard"
        detail={{ sessions: dashboard.totals.sessions, projects: projects.length }}
      >
        <Dashboard
          data={dashboard}
          projects={projects}
          bookmarkedSessions={bookmarkedSessions}
          isBookmarked={isSessionBookmarked}
          onToggleBookmark={(session, agentKey) => {
            if ("agentName" in session) {
              toggleSessionBookmark(session, agentKey ?? session.agentName.toLowerCase());
              return;
            }
            toggleBookmark(session);
          }}
        />
      </RenderProfiler>
    ) : (
      <DetailLanding
        type="global"
        sessions={landingSessions}
        agentItems={landingAgentItems}
        isBookmarked={isSessionBookmarked}
        onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
      />
    );
  } else if (viewState.mode === "projects") {
    content = <ProjectsOverview projects={projects} />;
  } else if (viewState.mode === "project") {
    content = (
      <ProjectDashboardView
        project={activeProject}
        projectKey={viewState.activeProjectKey}
        dashboard={projectDashboard}
        loading={projectDashboardLoading}
        error={projectDashboardError}
        sessions={activeProjectSessions}
        activeAgent={selectedProjectAgent}
        onChangeAgent={setSelectedProjectAgent}
        isBookmarked={isSessionBookmarked}
        onToggleSessionBookmark={toggleSessionBookmark}
      />
    );
  } else if (viewState.mode === "agent" && activeAgentKey) {
    const agentSessions = sessionIndexes.byLandingAgent.get(activeAgentKey) ?? [];
    content = (
      <DetailLanding
        type="agent"
        sessions={agentSessions}
        agentItems={landingAgentItems}
        activeAgentKey={activeAgentKey}
        isBookmarked={isSessionBookmarked}
        onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
      />
    );
  } else if (viewState.mode === "session") {
    if (sessionLoading) {
      content = <SessionDetailSkeleton />;
    } else if (sessionError || !session) {
      content = (
        <DetailLanding
          type="missing-session"
          sessions={sessionIndexes.byLandingAgent.get(viewState.activeAgentKey) ?? []}
          agentItems={landingAgentItems}
          activeAgentKey={viewState.activeAgentKey}
          attemptedSessionSlug={viewState.activeSessionSlug}
          isBookmarked={isSessionBookmarked}
          onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
        />
      );
    } else {
      content = (
        <RenderProfiler
          id="SessionDetail"
          detail={{ messages: session.messages.length, session: session.id }}
        >
          <SessionDetail session={session} highlightQuery={detailHighlightQuery} />
        </RenderProfiler>
      );
    }
  } else if (viewState.mode === "missingAgent") {
    content = (
      <DetailLanding
        type="missing-agent"
        sessions={landingSessions}
        agentItems={landingAgentItems}
        attemptedAgentKey={viewState.attemptedKey}
        isBookmarked={isSessionBookmarked}
        onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
      />
    );
  } else {
    content = <div className="text-sm text-[var(--console-muted)]">Invalid route.</div>;
  }

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
            <label className="flex min-w-0 flex-1 items-center rounded-sm border border-[var(--console-border)] bg-white px-2 py-1">
              <input
                ref={searchInputRef}
                value={draftSearchQuery}
                onChange={(event) => setDraftSearchQuery(event.target.value)}
                placeholder="Search sessions  /"
                className="console-mono w-full min-w-0 bg-transparent text-xs text-[var(--console-text)] outline-none placeholder:text-[var(--console-muted)]"
              />
            </label>
            <button
              type="submit"
              className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-3 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-white"
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
            {formatWindowLabel(appConfig) ? (
              <span
                className="console-mono hidden rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-xs text-[var(--console-text)] md:inline-flex"
                title="Time window applied to agent counts, dashboard, and session list"
              >
                {formatWindowLabel(appConfig)}
              </span>
            ) : null}
            <span className="console-mono hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-muted)] sm:inline-flex">
              v{__APP_VERSION__}
            </span>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <AppSidebar
          sidebarCollapsed={sidebarCollapsed}
          browseBy={browseBy}
          onChangeBrowseBy={changeBrowseBy}
          isScanActive={isScanActive}
          viewState={viewState}
          agents={agents}
          activeAgentKey={activeAgentKey}
          scanStatus={scanStatus}
          projects={projects}
          selectedProjectNavigationId={selectedProjectNavigationId}
          onSelectProject={setSelectedProjectIdentity}
          loading={loading}
          bookmarkedSessions={bookmarkedSessions}
          onToggleBookmark={toggleBookmark}
          sidebarSessions={sidebarSessions}
          selectedSidebarSessionId={selectedSidebarSessionId}
          bookmarkedSidebarSessionIds={bookmarkedSidebarSessionIds}
          onSelectFlatSidebarSession={handleSelectFlatSidebarSession}
          onToggleSidebarSessionBookmark={handleToggleSidebarSessionBookmark}
          onSelectTreeSidebarSession={handleSelectTreeSidebarSession}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <section className="shrink-0 border-b border-[var(--console-border)] bg-white/70 px-4 py-4 backdrop-blur-sm md:px-8">
            <div>
              <nav
                aria-label="Breadcrumb"
                className="console-mono mb-2 flex flex-wrap items-center gap-1 text-[11px] text-[var(--console-muted)]"
              >
                {breadcrumbItems.map((item, index) => (
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
                    {index < breadcrumbItems.length - 1 ? <span>/</span> : null}
                  </span>
                ))}
              </nav>
              <div className="flex items-center gap-2">
                <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--console-muted)]">
                  {viewState.mode === "session"
                    ? "Session"
                    : viewState.mode === "root"
                      ? "Dashboard"
                      : viewState.mode === "projects"
                        ? "Projects"
                        : viewState.mode === "project"
                          ? "Project"
                          : "Landing"}
                </span>
                <h1 className="console-mono text-xl font-semibold tracking-tight text-[var(--console-text)]">
                  {headerTitle}
                </h1>
              </div>
              <div className="console-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--console-muted)]">
                {headerSubtitle}
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
    </div>
  );
}
