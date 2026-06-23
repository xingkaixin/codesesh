declare const __APP_VERSION__: string;

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ModelConfig } from "./config";
import type {
  AgentInfo,
  AppConfig,
  BookmarkedSessionSnapshot,
  DashboardData,
  SearchRequestOptions,
  SearchResult,
  SessionHead,
  SessionData,
  ScanStatusEvent,
  SessionsUpdatedEvent,
  ProjectGroup,
} from "./lib/api";
import {
  deleteBookmark,
  fetchAgents,
  fetchBookmarks,
  fetchConfig,
  fetchDashboard,
  fetchProjects,
  fetchScanStatus,
  fetchSearchResults,
  fetchSessions,
  fetchSessionData,
  importBookmarks,
  logClientEvent,
  subscribeSessionUpdates,
  upsertBookmark,
} from "./lib/api";
import { SessionDetail } from "./components/SessionDetail";
import { SessionDetailSkeleton } from "./components/SessionDetailSkeleton";
import { DetailLanding, type LandingAgentItem } from "./components/DetailLanding";
import { Dashboard } from "./components/Dashboard";
import { ProjectDashboardView, ProjectsOverview } from "./components/Projects";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BookmarkButton } from "./components/BookmarkButton";
import { CopyResumeButton } from "./components/CopyResumeButton";
import { SessionTreeSidebar } from "./components/SessionTreeSidebar";
import { RenderProfiler } from "./components/RenderProfiler";
import { SmartTagChips } from "./components/SmartTagChips";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  mergeBookmarksWithSessions,
  toBookmarkedSessionSnapshot,
} from "./lib/bookmarks";
import { parseViewState } from "./lib/view-state";
import { BrowseByToggle } from "./components/app/BrowseByToggle";
import { SidebarFlatSessionList } from "./components/app/SidebarFlatSessionList";
import { SearchResultsPanel } from "./components/app/SearchResultsPanel";
import { COST_RANGE_OPTIONS } from "./components/app/SearchFilterBar";
import {
  type BrowseBy,
  type SearchFilterState,
  type SearchProjectOption,
} from "./components/app/types";
import {
  formatAgentScanProgress,
  formatRelativeTime,
  formatScanStatusLabel,
  formatSearchSubtitle,
  formatWindowLabel,
  getAgentDisplayCount,
} from "./lib/scan-format";
import { applyLiveSessionUpdate } from "./lib/live-update";
import { getProjectIdentityKey, getProjectPath, type ProjectRouteIdentity } from "./lib/projects";
import {
  buildSessionIndexes,
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionRouteKey,
} from "./lib/session-indexes";

function getProjectGroupIdentity(project: ProjectGroup): ProjectRouteIdentity {
  return { kind: project.identityKind, key: project.identityKey };
}

interface BreadcrumbItem {
  label: string;
  to?: string;
}

const SHORTCUT_HINT_STORAGE_KEY = "codesesh.shortcuts-hint-dismissed";

const SHORTCUT_GROUPS = [
  {
    title: "Navigation",
    items: [
      { keys: "j / k", description: "Move through sessions or search results" },
      { keys: "Enter", description: "Open the current selection" },
      { keys: "g / G", description: "Jump to the first or last item" },
    ],
  },
  {
    title: "Search",
    items: [
      { keys: "Cmd/Ctrl K", description: "Open global search" },
      { keys: "/", description: "Focus the search box" },
      { keys: "Esc", description: "Exit search or close the current detail view" },
    ],
  },
  {
    title: "Groups",
    items: [
      { keys: "g / G", description: "Jump to the first or last session" },
      { keys: "?", description: "Open this shortcuts panel" },
    ],
  },
] as const;

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

export default function App() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<SessionHead[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkedSessionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [browseBy, setBrowseBy] = useState<BrowseBy>("agents");
  const [selectedProjectIdentity, setSelectedProjectIdentity] =
    useState<ProjectRouteIdentity | null>(null);
  const [projectDashboard, setProjectDashboard] = useState<DashboardData | null>(null);
  const [projectDashboardLoading, setProjectDashboardLoading] = useState(false);
  const [projectDashboardError, setProjectDashboardError] = useState<string | null>(null);
  const [selectedProjectAgent, setSelectedProjectAgent] = useState<string | undefined>(undefined);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [draftSearchQuery, setDraftSearchQuery] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilterState>({});
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatusEvent | null>(null);
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutHintDismissed, setShortcutHintDismissed] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchResultRefs = useRef(new Map<string, HTMLAnchorElement>());

  // Load config + agents + sessions + dashboard (all share the same app-level window)
  useEffect(() => {
    const ac = new AbortController();
    const startedAt = performance.now();
    logClientEvent("app.load.start", { path: window.location.pathname });
    (async () => {
      try {
        const config = await fetchConfig();
        setAppConfig(config);
        const [agentList, sessionList, dashboardData, projectData, bookmarkData, statusData] =
          await Promise.all([
            fetchAgents(),
            fetchSessions({ from: config.window.from, to: config.window.to }),
            fetchDashboard(config.window).catch((err) => {
              console.error("Failed to load dashboard:", err);
              return null;
            }),
            fetchProjects().catch((err) => {
              console.error("Failed to load projects:", err);
              return { projects: [] };
            }),
            fetchBookmarks(),
            fetchScanStatus().catch((err) => {
              console.error("Failed to load scan status:", err);
              return null;
            }),
          ]);
        setAgents(agentList);
        setSessions(sessionList.sessions);
        setProjects(projectData.projects);
        setBookmarks(bookmarkData.bookmarks);
        if (statusData) setScanStatus(statusData);
        if (dashboardData) setDashboard(dashboardData);
        logClientEvent("app.load.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          agents: agentList.length,
          sessions: sessionList.sessions.length,
          projects: projectData.projects.length,
          dashboard: Boolean(dashboardData),
        });
      } catch (err) {
        console.error("Failed to load data:", err);
        logClientEvent("app.load.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setError("Failed to load data. Is the CLI server running?");
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, []);

  const location = useLocation();
  const validAgentKeys = useMemo(() => new Set(agents.map((a) => a.name.toLowerCase())), [agents]);
  const agentNameMap = useMemo(
    () => new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.displayName])),
    [agents],
  );
  const isSearchMode = searchMode;

  const viewState = useMemo(
    () => parseViewState(location.pathname, validAgentKeys),
    [location.pathname, validAgentKeys],
  );

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
  const detailHighlightQuery = isSearchMode
    ? activeSearchQuery
    : typeof location.state === "object" &&
        location.state !== null &&
        "searchQuery" in location.state &&
        typeof location.state.searchQuery === "string"
      ? location.state.searchQuery
      : "";

  const sessionIndexes = useMemo(() => buildSessionIndexes(sessions, agents), [sessions, agents]);

  useEffect(() => {
    let cancelled = false;

    setBookmarks((prev) => {
      const next = mergeBookmarksWithSessions(prev, sessions);
      if (next === prev) return prev;
      void importBookmarks(
        next.map(({ bookmarked_at: _bookmarkedAt, ...bookmark }) => bookmark),
      ).catch((error) => {
        if (!cancelled) {
          console.error("Failed to sync bookmark snapshots:", error);
        }
      });
      return next;
    });

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const legacy = loadLegacyBookmarks();
      if (legacy.length === 0) return;

      try {
        const data = await importBookmarks(
          legacy.map(({ bookmarked_at: _bookmarkedAt, ...bookmark }) => bookmark),
        );
        if (cancelled) return;
        setBookmarks(data.bookmarks);
        clearLegacyBookmarks();
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to migrate legacy bookmarks:", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const bookmarkKeySet = useMemo(
    () =>
      new Set(
        bookmarks.map((bookmark) => getSessionBookmarkKey(bookmark.agentKey, bookmark.sessionId)),
      ),
    [bookmarks],
  );

  const isSessionBookmarked = useCallback(
    (agentKey: string, sessionId: string): boolean =>
      bookmarkKeySet.has(getSessionBookmarkKey(agentKey, sessionId)),
    [bookmarkKeySet],
  );

  const toggleBookmark = useCallback(
    (snapshot: BookmarkedSessionSnapshot) => {
      const key = getSessionBookmarkKey(snapshot.agentKey, snapshot.sessionId);
      const exists = bookmarkKeySet.has(key);
      const previous = bookmarks;
      const next = exists
        ? previous.filter(
            (bookmark) => getSessionBookmarkKey(bookmark.agentKey, bookmark.sessionId) !== key,
          )
        : [...previous, snapshot].toSorted((a, b) => {
            const aTime = a.time_updated ?? a.time_created;
            const bTime = b.time_updated ?? b.time_created;
            return bTime - aTime;
          });

      setBookmarks(next);
      logClientEvent(exists ? "bookmark.delete" : "bookmark.add", {
        agent: snapshot.agentKey,
        session: snapshot.sessionId,
      });

      void (
        exists
          ? deleteBookmark(snapshot.agentKey, snapshot.sessionId)
          : upsertBookmark({
              agentKey: snapshot.agentKey,
              sessionId: snapshot.sessionId,
              fullPath: snapshot.fullPath,
              title: snapshot.title,
              directory: snapshot.directory,
              time_created: snapshot.time_created,
              time_updated: snapshot.time_updated,
              stats: snapshot.stats,
            })
      ).catch((error) => {
        console.error("Failed to toggle bookmark:", error);
        setBookmarks(previous);
      });
    },
    [bookmarkKeySet, bookmarks],
  );

  const toggleSessionBookmark = useCallback(
    (session: SessionHead, agentKey: string) => {
      toggleBookmark(toBookmarkedSessionSnapshot(session, agentKey));
    },
    [toggleBookmark],
  );

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
          bookmarkKeySet.has(
            getSessionBookmarkKey(getSessionAgentKey(sessionItem), sessionItem.id),
          ),
        )
        .map((sessionItem) => sessionItem.id),
    );
  }, [bookmarkKeySet, sidebarSessions]);

  const bookmarkedSessions = useMemo(
    () =>
      bookmarks.toSorted(
        (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
      ),
    [bookmarks],
  );

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

  const searchRequestOptions = useMemo<SearchRequestOptions>(() => {
    const selectedCost = COST_RANGE_OPTIONS.find((option) => option.id === searchFilters.costRange);
    return {
      agent: searchFilters.agent,
      projectKey: searchFilters.projectKey,
      tag: searchFilters.tag,
      tool: searchFilters.tool,
      fileKind: searchFilters.fileKind,
      costMin: selectedCost?.costMin,
    };
  }, [searchFilters]);
  const usesServerSearch =
    activeSearchQuery.trim().length > 0 || Boolean(searchFilters.tool || searchFilters.fileKind);
  const scanStatusLabel = formatScanStatusLabel(scanStatus);
  const isScanActive = scanStatus?.active === true;
  const recentSearchResults = useMemo<SearchResult[]>(() => {
    const selectedCost = COST_RANGE_OPTIONS.find((option) => option.id === searchFilters.costRange);
    const agentSessions = searchFilters.agent
      ? (sessionIndexes.byAgent.get(searchFilters.agent) ?? [])
      : null;
    const projectSessions = searchFilters.projectKey
      ? (sessionIndexes.byProjectKey.get(searchFilters.projectKey) ?? [])
      : null;
    const sourceSessions =
      agentSessions && projectSessions
        ? agentSessions.length <= projectSessions.length
          ? agentSessions
          : projectSessions
        : (agentSessions ?? projectSessions ?? sessionIndexes.sessionsByActivity);
    const results: SearchResult[] = [];

    for (const sessionItem of sourceSessions) {
      if (searchFilters.agent && getSessionAgentKey(sessionItem) !== searchFilters.agent) continue;
      if (
        searchFilters.projectKey &&
        sessionItem.project_identity?.key !== searchFilters.projectKey
      ) {
        continue;
      }
      if (searchFilters.tag && !sessionItem.smart_tags?.includes(searchFilters.tag)) continue;
      if (selectedCost && sessionItem.stats.total_cost < selectedCost.costMin) continue;

      results.push({
        agentName: getSessionAgentKey(sessionItem),
        session: sessionItem,
        snippet: `Recent session · ${sessionItem.directory}`,
        matchType: "recent" as const,
      });
      if (results.length >= 50) break;
    }

    return results;
  }, [searchFilters, sessionIndexes]);

  // Stable key for session fetch
  const sessionFetchKey =
    viewState.mode === "session"
      ? `${viewState.activeAgentKey}/${viewState.activeSessionSlug}`
      : "";

  const syncLiveUpdate = useEffectEvent(async (event: SessionsUpdatedEvent) => {
    try {
      const canApplySessionUpdate = Boolean(event.changedSessionHeads && event.removedSessionRefs);
      if (canApplySessionUpdate) {
        setSessions((current) => applyLiveSessionUpdate(current, event) ?? current);
      }

      const [agentList, sessionList, dashboardData, projectData, projectDashboardData, searchData] =
        await Promise.all([
          fetchAgents(),
          canApplySessionUpdate
            ? Promise.resolve<{ sessions: SessionHead[] } | null>(null)
            : fetchSessions({ from: appConfig?.window.from, to: appConfig?.window.to }),
          fetchDashboard(appConfig?.window).catch((err) => {
            console.error("Failed to refresh dashboard:", err);
            return null;
          }),
          fetchProjects().catch((err) => {
            console.error("Failed to refresh projects:", err);
            return { projects: [] };
          }),
          viewState.mode === "project"
            ? fetchDashboard(appConfig?.window, {
                projectKind: viewState.activeProjectKind,
                projectKey: viewState.activeProjectKey,
                agent: selectedProjectAgent,
              }).catch((err) => {
                console.error("Failed to refresh project dashboard:", err);
                return null;
              })
            : Promise.resolve<DashboardData | null>(null),
          isSearchMode && usesServerSearch
            ? fetchSearchResults(activeSearchQuery, searchRequestOptions).catch((err) => {
                console.error("Failed to refresh search results:", err);
                return { results: [] };
              })
            : Promise.resolve<{ results: SearchResult[] } | null>(null),
        ]);
      setAgents(agentList);
      if (sessionList) setSessions(sessionList.sessions);
      setProjects(projectData.projects);
      if (dashboardData) setDashboard(dashboardData);
      if (projectDashboardData) setProjectDashboard(projectDashboardData);
      if (searchData) setSearchResults(searchData.results);

      if (viewState.mode === "session") {
        try {
          const data = await fetchSessionData(
            viewState.activeAgentKey,
            viewState.activeSessionSlug,
          );
          setSession(data);
          setSessionError(null);
        } catch {
          setSession(null);
          setSessionError("Session not found");
        }
      }

      if (event.newSessions > 0) {
        setLiveNotice(`发现 ${event.newSessions} 个新会话，列表已自动刷新`);
      }
    } catch (err) {
      console.error("Failed to sync live session update:", err);
    }
  });

  useEffect(() => {
    if (!isSearchMode) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    if (!usesServerSearch) {
      setSearchResults(recentSearchResults);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    const startedAt = performance.now();
    logClientEvent("search.start", { query_length: activeSearchQuery.length });

    void fetchSearchResults(activeSearchQuery, searchRequestOptions)
      .then((data) => {
        if (cancelled) return;
        setSearchResults(data.results);
        logClientEvent("search.done", {
          duration_ms: Math.round(performance.now() - startedAt),
          results: data.results.length,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load search results:", err);
        logClientEvent("search.error", {
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setSearchResults([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSearchQuery,
    isSearchMode,
    recentSearchResults,
    searchRequestOptions,
    usesServerSearch,
  ]);

  // Load session detail
  useEffect(() => {
    if (viewState.mode !== "session") {
      setSession(null);
      setSessionError(null);
      return;
    }
    const ac = new AbortController();
    setSessionLoading(true);
    setSessionError(null);
    const startedAt = performance.now();
    logClientEvent("session.open.start", {
      agent: viewState.activeAgentKey,
      session: viewState.activeSessionSlug,
    });
    (async () => {
      try {
        const data = await fetchSessionData(viewState.activeAgentKey, viewState.activeSessionSlug);
        setSession(data);
        logClientEvent("session.open.done", {
          agent: viewState.activeAgentKey,
          session: viewState.activeSessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          messages: data.messages.length,
        });
      } catch (err) {
        logClientEvent("session.open.error", {
          agent: viewState.activeAgentKey,
          session: viewState.activeSessionSlug,
          duration_ms: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setSessionError("Session not found");
        setSession(null);
      } finally {
        setSessionLoading(false);
      }
    })();
    return () => ac.abort();
  }, [sessionFetchKey, viewState.activeAgentKey, viewState.activeSessionSlug, viewState.mode]);

  useEffect(() => {
    if (activeProjectIdentityKey) setSelectedProjectAgent(undefined);
  }, [activeProjectIdentityKey]);

  useEffect(() => {
    if (!activeProjectKey || !appConfig) {
      setProjectDashboard(null);
      setProjectDashboardError(null);
      setProjectDashboardLoading(false);
      return;
    }

    let cancelled = false;
    setProjectDashboardLoading(true);
    setProjectDashboardError(null);

    void fetchDashboard(appConfig.window, {
      projectKind: activeProjectKind ?? undefined,
      projectKey: activeProjectKey,
      agent: selectedProjectAgent,
    })
      .then((data) => {
        if (cancelled) return;
        setProjectDashboard(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load project dashboard:", err);
        setProjectDashboard(null);
        setProjectDashboardError("Failed to load project dashboard");
      })
      .finally(() => {
        if (cancelled) return;
        setProjectDashboardLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectKind, activeProjectKey, appConfig, selectedProjectAgent]);

  useEffect(() => {
    const unsubscribe = subscribeSessionUpdates(
      (event) => {
        void syncLiveUpdate(event);
      },
      (event) => {
        setScanStatus(event);
      },
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!liveNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLiveNotice(null);
    }, 3500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [liveNotice]);

  useEffect(() => {
    try {
      setShortcutHintDismissed(window.localStorage.getItem(SHORTCUT_HINT_STORAGE_KEY) === "1");
    } catch {
      setShortcutHintDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (isSearchMode) {
      setSelectedSearchIndex((current) => {
        if (searchResults.length === 0) return 0;
        return Math.min(current, searchResults.length - 1);
      });
      return;
    }

    if (viewState.mode === "session") {
      setSelectedSidebarSessionId(viewState.activeSessionSlug);
      return;
    }

    if (viewState.mode === "agent") {
      setSelectedSidebarSessionId(null);
      return;
    }

    setSelectedSidebarSessionId(null);
  }, [
    isSearchMode,
    searchResults.length,
    viewState.mode,
    viewState.activeSessionSlug,
    sidebarSessions,
  ]);

  useEffect(() => {
    if (!isSearchMode) return;
    const selectedResult = searchResults[selectedSearchIndex];
    if (!selectedResult) return;
    const key = `${selectedResult.agentName}/${selectedResult.session.id}`;
    searchResultRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [isSearchMode, searchResults, selectedSearchIndex]);

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
      const current = byKey.get(identity.key);
      if (current) {
        current.count += 1;
      } else {
        byKey.set(identity.key, {
          key: identity.key,
          label: identity.displayName || result.session.directory,
          count: 1,
          showCount: false,
        });
      }
    }

    if (searchFilters.projectKey && !byKey.has(searchFilters.projectKey)) {
      const selected = projectOptions.find((project) => project.key === searchFilters.projectKey);
      if (selected) {
        byKey.set(selected.key, { ...selected, count: 0, showCount: false });
      }
    }

    return [...byKey.values()].toSorted((a, b) => b.count - a.count).slice(0, 8);
  }, [projectOptions, searchFilters.projectKey, searchLoading, searchResults, usesServerSearch]);

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
          onOpenResult={() => {
            setSearchMode(false);
            setActiveSearchQuery("");
          }}
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

  function runSearch() {
    setActiveSearchQuery(draftSearchQuery.trim());
    setSearchMode(true);
    setSelectedSearchIndex(0);
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

  const handleGlobalKeydown = useEffectEvent((event: KeyboardEvent) => {
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") {
      event.preventDefault();
      setSearchMode(true);
      setSelectedSearchIndex(0);
      window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 0);
      return;
    }

    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing) return;

    const target = event.target;
    const inEditable = isEditableTarget(target);

    if (shortcutHelpOpen) {
      if (key === "Escape") {
        event.preventDefault();
        setShortcutHelpOpen(false);
      }
      return;
    }

    if (inEditable) {
      if (key === "Escape") {
        event.preventDefault();
        if (target instanceof HTMLElement) target.blur();
      }
      return;
    }

    if (key === "?") {
      event.preventDefault();
      setShortcutHelpOpen(true);
      dismissShortcutHint();
      return;
    }

    if (key === "/") {
      event.preventDefault();
      dismissShortcutHint();
      setSearchMode(true);
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }

    if (key === "Escape") {
      event.preventDefault();
      if (isSearchMode) {
        setSearchMode(false);
        setActiveSearchQuery("");
        setDraftSearchQuery("");
        return;
      }
      if (viewState.mode === "session" && viewState.activeAgentKey) {
        if (browseBy === "projects" && selectedProjectNavigationIdentity) {
          navigate(getProjectPath(selectedProjectNavigationIdentity));
          return;
        }
        navigate(`/${viewState.activeAgentKey}`);
      }
      return;
    }

    if (isSearchMode) {
      if (searchResults.length === 0) return;

      if (key === "j") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex((current) => Math.min(current + 1, searchResults.length - 1));
        return;
      }
      if (key === "k") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (key === "g") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex(0);
        return;
      }
      if (key === "G") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex(searchResults.length - 1);
        return;
      }
      if (key === "Enter") {
        const result = searchResults[selectedSearchIndex];
        if (!result) return;
        event.preventDefault();
        dismissShortcutHint();
        setSearchMode(false);
        setActiveSearchQuery("");
        navigate(`/${result.agentName.toLowerCase()}/${result.session.id}`, {
          state: { searchQuery: activeSearchQuery },
        });
      }
      return;
    }

    if (browseBy === "agents" && !activeAgentKey) return;
    if (sidebarSessions.length === 0) return;

    const moveSidebarSelection = (offset: number) => {
      dismissShortcutHint();
      const currentIndex =
        selectedSidebarSessionId != null
          ? (sidebarSessionLookup.indexById.get(selectedSidebarSessionId) ?? -1)
          : -1;
      const baseIndex =
        currentIndex >= 0 ? currentIndex : offset >= 0 ? -1 : sidebarSessions.length;
      const nextIndex = Math.max(0, Math.min(baseIndex + offset, sidebarSessions.length - 1));
      setSelectedSidebarSessionId(sidebarSessions[nextIndex]?.id ?? null);
    };

    if (key === "j") {
      event.preventDefault();
      moveSidebarSelection(1);
      return;
    }
    if (key === "k") {
      event.preventDefault();
      moveSidebarSelection(-1);
      return;
    }
    if (key === "g") {
      event.preventDefault();
      dismissShortcutHint();
      setSelectedSidebarSessionId(sidebarSessions[0]?.id ?? null);
      return;
    }
    if (key === "G") {
      event.preventDefault();
      dismissShortcutHint();
      setSelectedSidebarSessionId(sidebarSessions.at(-1)?.id ?? null);
      return;
    }
    if (key === "Enter") {
      const selected =
        selectedSidebarSessionId != null
          ? sidebarSessionLookup.byId.get(selectedSidebarSessionId)
          : null;
      if (!selected) return;
      event.preventDefault();
      dismissShortcutHint();
      navigate(browseBy === "projects" ? `/${selected.slug}` : `/${activeAgentKey}/${selected.id}`);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, []);

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
              runSearch();
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
        <aside
          className={`w-64 shrink-0 flex-col border-r border-[var(--console-border)] bg-[var(--console-sidebar-bg)] ${
            sidebarCollapsed ? "hidden" : "hidden lg:flex"
          }`}
        >
          <div className="console-scrollbar flex-1 space-y-8 overflow-y-auto px-4 py-6">
            <section>
              <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
                BROWSE BY
              </h3>
              <BrowseByToggle
                value={browseBy}
                onChange={changeBrowseBy}
                projectsDisabled={isScanActive}
              />
            </section>

            <section>
              <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
                NAVIGATION
              </h3>
              <ul
                className={`space-y-1 ${
                  browseBy === "projects"
                    ? "console-scrollbar max-h-[min(280px,calc(100vh-440px))] overflow-y-auto pr-1"
                    : ""
                }`}
              >
                <li>
                  <Link
                    to={browseBy === "projects" ? "/projects" : "/"}
                    className={`flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left transition-colors ${
                      (browseBy === "agents" && viewState.mode === "root") ||
                      (browseBy === "projects" && viewState.mode === "projects")
                        ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                        : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                    }`}
                  >
                    <img src="/logo.svg?v=3" alt="Dashboard" className="size-3.5 rounded-[2px]" />
                    <span className="console-mono line-clamp-1 flex-1 text-xs">Dashboard</span>
                  </Link>
                </li>
                {browseBy === "agents"
                  ? agents.map((agent) => {
                      const key = agent.name.toLowerCase();
                      const isSelected = key === activeAgentKey;
                      const config = ModelConfig.agents[key];
                      const agentProgress = formatAgentScanProgress(scanStatus, agent.name);
                      const disabled = isScanActive && agentProgress !== null;
                      const className = `ml-4 flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left transition-colors ${
                        disabled
                          ? "cursor-not-allowed border-transparent text-[var(--console-muted)] opacity-50"
                          : isSelected
                            ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                            : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                      }`;
                      const content = (
                        <>
                          {config?.icon && (
                            <img
                              src={config.icon}
                              alt={agent.displayName}
                              className="size-3.5 object-contain"
                            />
                          )}
                          <span className="console-mono line-clamp-1 flex-1 text-xs">
                            {agent.displayName}
                          </span>
                          <span className="console-mono text-[11px] text-[var(--console-muted)]">
                            {agentProgress ??
                              getAgentDisplayCount(scanStatus, agent.name, agent.count)}
                          </span>
                        </>
                      );
                      return (
                        <li key={agent.name}>
                          {disabled ? (
                            <span
                              className={className}
                              title="Available after this agent scan completes"
                            >
                              {content}
                            </span>
                          ) : (
                            <Link to={`/${key}`} className={className}>
                              {content}
                            </Link>
                          )}
                          {agentProgress ? (
                            <span className="ml-4 mt-1 block h-1 overflow-hidden rounded-sm bg-[var(--console-surface-muted)]">
                              <span
                                className="block h-full bg-[var(--console-accent)]"
                                style={{
                                  width: `${
                                    scanStatus?.agentStatuses[agent.name]?.total
                                      ? Math.round(
                                          ((scanStatus.agentStatuses[agent.name]?.processed ?? 0) /
                                            scanStatus.agentStatuses[agent.name]!.total!) *
                                            100,
                                        )
                                      : 8
                                  }%`,
                                }}
                              />
                            </span>
                          ) : null}
                        </li>
                      );
                    })
                  : projects.map((project) => {
                      const projectIdentity = getProjectGroupIdentity(project);
                      const isSelected =
                        selectedProjectNavigationId === getProjectIdentityKey(projectIdentity);
                      return (
                        <li key={`${project.identityKind}:${project.identityKey}`}>
                          <Link
                            to={getProjectPath(projectIdentity)}
                            onClick={() => setSelectedProjectIdentity(projectIdentity)}
                            className={`ml-4 flex min-w-0 items-center gap-2 rounded-sm border px-3 py-1.5 text-left transition-colors ${
                              isSelected
                                ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                                : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                            }`}
                          >
                            <span className="console-mono min-w-0 flex-1 truncate text-xs">
                              {project.displayName}
                            </span>
                            <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                              {project.sessionCount}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                {browseBy === "agents" && agents.length === 0 && !loading ? (
                  <li>
                    <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                      {scanStatus?.active ? "Scanning agents..." : "No agents found"}
                    </span>
                  </li>
                ) : null}
                {browseBy === "projects" && projects.length === 0 && !loading ? (
                  <li>
                    <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                      {scanStatus?.active ? "Scanning projects..." : "No projects found"}
                    </span>
                  </li>
                ) : null}
              </ul>
            </section>

            <section>
              <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
                BOOKMARKS
              </h3>
              {bookmarkedSessions.length === 0 ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  No bookmarks yet
                </span>
              ) : (
                <ul className="space-y-1">
                  {bookmarkedSessions.map((session) => {
                    const isActive =
                      viewState.mode === "session" &&
                      viewState.activeAgentKey === session.agentKey &&
                      viewState.activeSessionSlug === session.sessionId;
                    const agent = ModelConfig.agents[session.agentKey];
                    return (
                      <li key={getSessionBookmarkKey(session.agentKey, session.sessionId)}>
                        <div
                          className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 transition-colors ${
                            isActive
                              ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                              : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                          }`}
                        >
                          <Link
                            to={`/${session.fullPath}`}
                            className="flex min-w-0 flex-1 items-start gap-2"
                          >
                            {agent?.icon ? (
                              <img
                                src={agent.icon}
                                alt={agent.name}
                                className="mt-0.5 size-3.5 shrink-0 object-contain"
                              />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <span className="console-mono line-clamp-1 block text-xs">
                                {session.title}
                              </span>
                              <span className="console-mono mt-0.5 line-clamp-1 block text-[10px] text-[var(--console-muted)]">
                                {agent?.name ?? session.agentKey}
                              </span>
                            </div>
                          </Link>
                          <BookmarkButton active onToggle={() => toggleBookmark(session)} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
                SESSIONS
                {sidebarSessions.length > 0 ? (
                  <span className="ml-2 text-[10px] font-normal text-[var(--console-muted)]">
                    Navigate j k · Open Enter
                  </span>
                ) : null}
              </h3>
              {browseBy === "agents" && !activeAgentKey ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  Select an agent
                </span>
              ) : browseBy === "projects" && !selectedProjectNavigationId ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  Select a project
                </span>
              ) : sidebarSessions.length === 0 ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  {scanStatus?.active ? "Scanning sessions..." : "No sessions yet"}
                </span>
              ) : browseBy === "projects" ? (
                <SidebarFlatSessionList
                  sessions={sidebarSessions}
                  activeSessionId={
                    viewState.mode === "session" ? viewState.activeSessionSlug : null
                  }
                  selectedSessionId={selectedSidebarSessionId}
                  bookmarkedSessionIds={bookmarkedSidebarSessionIds}
                  onSelectSession={handleSelectFlatSidebarSession}
                  onToggleBookmark={handleToggleSidebarSessionBookmark}
                />
              ) : (
                <RenderProfiler
                  id="SessionTreeSidebar"
                  detail={{ sessions: sidebarSessions.length }}
                >
                  <SessionTreeSidebar
                    sessions={sidebarSessions}
                    activeSessionId={
                      viewState.mode === "session" ? viewState.activeSessionSlug : null
                    }
                    selectedSessionId={selectedSidebarSessionId}
                    onSelectSession={handleSelectTreeSidebarSession}
                    bookmarkedSessionIds={bookmarkedSidebarSessionIds}
                    onToggleBookmark={handleToggleSidebarSessionBookmark}
                  />
                </RenderProfiler>
              )}
            </section>
          </div>
        </aside>

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
      {shortcutHelpOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          onClick={() => setShortcutHelpOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            className="w-full max-w-2xl rounded-sm border border-[var(--console-border-strong)] bg-white p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
                  Keyboard Shortcuts
                </p>
                <h2 className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">
                  Navigate without leaving the keyboard
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShortcutHelpOpen(false)}
                className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-white"
              >
                Esc
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {SHORTCUT_GROUPS.map((group) => (
                <div
                  key={group.title}
                  className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-4"
                >
                  <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
                    {group.title}
                  </h3>
                  <div className="mt-3 space-y-3">
                    {group.items.map((item) => (
                      <div key={item.keys}>
                        <p className="console-mono text-xs text-[var(--console-text)]">
                          {item.keys}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-[var(--console-muted)]">
                          {item.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
