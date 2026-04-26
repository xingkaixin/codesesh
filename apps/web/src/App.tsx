declare const __APP_VERSION__: string;

import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ModelConfig } from "./config";
import type {
  AgentInfo,
  AppConfig,
  BookmarkedSessionSnapshot,
  DashboardData,
  SearchResult,
  SessionHead,
  SessionData,
  SessionsUpdatedEvent,
} from "./lib/api";
import {
  deleteBookmark,
  fetchAgents,
  fetchBookmarks,
  fetchConfig,
  fetchDashboard,
  fetchSearchResults,
  fetchSessions,
  fetchSessionData,
  importBookmarks,
  subscribeSessionUpdates,
  upsertBookmark,
} from "./lib/api";
import { SessionDetail } from "./components/SessionDetail";
import { SessionDetailSkeleton } from "./components/SessionDetailSkeleton";
import {
  DetailLanding,
  type LandingSession,
  type LandingAgentItem,
} from "./components/DetailLanding";
import { Dashboard } from "./components/Dashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BookmarkButton } from "./components/BookmarkButton";
import { CopyResumeButton } from "./components/CopyResumeButton";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  mergeBookmarksWithSessions,
  toBookmarkedSessionSnapshot,
} from "./lib/bookmarks";

type ViewState =
  | { mode: "root"; activeAgentKey: null; activeSessionSlug: null }
  | { mode: "agent"; activeAgentKey: string; activeSessionSlug: null }
  | { mode: "session"; activeAgentKey: string; activeSessionSlug: string }
  | { mode: "missingAgent"; activeAgentKey: null; activeSessionSlug: null; attemptedKey: string }
  | {
      mode: "missingSession";
      activeAgentKey: string;
      activeSessionSlug: string;
      attemptedSessionSlug: string;
    }
  | { mode: "invalidRoute"; activeAgentKey: null; activeSessionSlug: null };

function parseViewState(pathname: string, validAgentKeys: Set<string>): ViewState {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  const segments = trimmed
    ? trimmed
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (segments.length === 0) {
    return { mode: "root", activeAgentKey: null, activeSessionSlug: null };
  }
  if (segments.length === 1) {
    const key = segments[0]!.toLowerCase();
    if (validAgentKeys.has(key)) {
      return { mode: "agent", activeAgentKey: key, activeSessionSlug: null };
    }
    return {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionSlug: null,
      attemptedKey: key,
    };
  }
  if (segments.length === 2) {
    const key = segments[0]!.toLowerCase();
    const slug = segments[1]!;
    if (validAgentKeys.has(key) && slug) {
      return { mode: "session", activeAgentKey: key, activeSessionSlug: slug };
    }
    if (validAgentKeys.has(key)) {
      return {
        mode: "missingSession",
        activeAgentKey: key,
        activeSessionSlug: slug,
        attemptedSessionSlug: slug,
      };
    }
    return {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionSlug: null,
      attemptedKey: key,
    };
  }
  return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
}

function formatIsoDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatWindowLabel(config: AppConfig | null): string | null {
  if (!config) return null;
  const { from, to, days } = config.window;
  if (from == null) return "All time";
  const fromStr = formatIsoDate(from);
  const toStr = formatIsoDate(to ?? Date.now());
  if (days) return `Last ${days}d · ${fromStr} → ${toStr}`;
  return `${fromStr} → ${toStr}`;
}

function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return "unknown";
  const diff = Date.now() - timestamp;
  if (Number.isNaN(diff) || diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toSafeSnippetHtml(snippet: string): string {
  return snippet
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
}

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface SidebarSessionEntry {
  session: SessionHead;
  groupKey: string;
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
      { keys: "/", description: "Focus the search box" },
      { keys: "Esc", description: "Exit search or close the current detail view" },
    ],
  },
  {
    title: "Groups",
    items: [
      { keys: "h / l", description: "Collapse or expand the selected session group" },
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
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [draftSearchQuery, setDraftSearchQuery] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [shortcutHintDismissed, setShortcutHintDismissed] = useState(true);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarItemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const searchResultRefs = useRef(new Map<string, HTMLAnchorElement>());

  // Load config + agents + sessions + dashboard (all share the same app-level window)
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const config = await fetchConfig();
        setAppConfig(config);
        const [agentList, sessionList, dashboardData, bookmarkData] = await Promise.all([
          fetchAgents(),
          fetchSessions(),
          fetchDashboard(config.window.days).catch((err) => {
            console.error("Failed to load dashboard:", err);
            return null;
          }),
          fetchBookmarks(),
        ]);
        setAgents(agentList);
        setSessions(sessionList.sessions);
        setBookmarks(bookmarkData.bookmarks);
        if (dashboardData) setDashboard(dashboardData);
      } catch (err) {
        console.error("Failed to load data:", err);
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
  const isSearchMode = activeSearchQuery.length > 0;

  const viewState = useMemo(
    () => parseViewState(location.pathname, validAgentKeys),
    [location.pathname, validAgentKeys],
  );
  const detailHighlightQuery = isSearchMode
    ? activeSearchQuery
    : typeof location.state === "object" &&
        location.state !== null &&
        "searchQuery" in location.state &&
        typeof location.state.searchQuery === "string"
      ? location.state.searchQuery
      : "";

  const sessionsByAgent = useMemo(() => {
    const grouped: Record<string, SessionHead[]> = {};
    for (const a of agents) {
      grouped[a.name] = [];
    }
    for (const s of sessions) {
      const agentKey = s.slug.split("/")[0]?.toLowerCase();
      if (agentKey && grouped[agentKey]) {
        grouped[agentKey].push(s);
      }
    }
    for (const key of Object.keys(grouped)) {
      grouped[key]!.sort(
        (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
      );
    }
    return grouped;
  }, [sessions, agents]);

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

  function isSessionBookmarked(agentKey: string, sessionId: string): boolean {
    return bookmarkKeySet.has(getSessionBookmarkKey(agentKey, sessionId));
  }

  function toggleBookmark(snapshot: BookmarkedSessionSnapshot) {
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
  }

  function toggleSessionBookmark(session: SessionHead, agentKey: string) {
    toggleBookmark(toBookmarkedSessionSnapshot(session, agentKey));
  }

  const activeAgentKey = viewState.activeAgentKey;
  const sidebarSessions = useMemo(
    () => (activeAgentKey ? (sessionsByAgent[activeAgentKey] ?? []) : []),
    [activeAgentKey, sessionsByAgent],
  );

  const bookmarkedSessions = useMemo(
    () =>
      bookmarks.toSorted(
        (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
      ),
    [bookmarks],
  );

  // Group sidebar sessions by last cwd component (file-tree style)
  type SessionGroup = { key: string; label: string; sessions: typeof sidebarSessions };
  const sidebarGroups = useMemo<SessionGroup[]>(() => {
    const map = new Map<string, SessionGroup>();
    for (const s of sidebarSessions) {
      const dir = s.directory ?? "";
      const label = dir ? (dir.replace(/\/+$/, "").split("/").at(-1) ?? dir) : "(unknown)";
      const groupKey = label !== "(unknown)" ? label : "__unknown__";
      if (!map.has(groupKey)) map.set(groupKey, { key: groupKey, label, sessions: [] });
      map.get(groupKey)!.sessions.push(s);
    }
    // Sort groups by most recent session time descending; unknown always last
    return [...map.values()].sort((a, b) => {
      if (a.key === "__unknown__") return 1;
      if (b.key === "__unknown__") return -1;
      const aTime = Math.max(...a.sessions.map((s) => s.time_updated ?? s.time_created));
      const bTime = Math.max(...b.sessions.map((s) => s.time_updated ?? s.time_created));
      return bTime - aTime;
    });
  }, [sidebarSessions]);

  // Default: all groups collapsed; track which are expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Reset to all-collapsed when agent changes
  useEffect(() => {
    setExpandedGroups(new Set());
  }, [activeAgentKey]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleSidebarSessions = useMemo<SidebarSessionEntry[]>(() => {
    return sidebarGroups.flatMap((group) =>
      expandedGroups.has(group.key)
        ? group.sessions.map((session) => ({ session, groupKey: group.key }))
        : [],
    );
  }, [expandedGroups, sidebarGroups]);

  // Stable key for session fetch
  const sessionFetchKey =
    viewState.mode === "session"
      ? `${viewState.activeAgentKey}/${viewState.activeSessionSlug}`
      : "";

  const syncLiveUpdate = useEffectEvent(async (event: SessionsUpdatedEvent) => {
    try {
      const [agentList, sessionList, dashboardData, searchData] = await Promise.all([
        fetchAgents(),
        fetchSessions(),
        fetchDashboard(appConfig?.window.days).catch((err) => {
          console.error("Failed to refresh dashboard:", err);
          return null;
        }),
        activeSearchQuery
          ? fetchSearchResults(activeSearchQuery).catch((err) => {
              console.error("Failed to refresh search results:", err);
              return { results: [] };
            })
          : Promise.resolve<{ results: SearchResult[] } | null>(null),
      ]);
      setAgents(agentList);
      setSessions(sessionList.sessions);
      if (dashboardData) setDashboard(dashboardData);
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
      } else if (event.updatedSessions > 0) {
        setLiveNotice("会话内容已同步");
      }
    } catch (err) {
      console.error("Failed to sync live session update:", err);
    }
  });

  useEffect(() => {
    if (!activeSearchQuery) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);

    void fetchSearchResults(activeSearchQuery)
      .then((data) => {
        if (cancelled) return;
        setSearchResults(data.results);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load search results:", err);
        setSearchResults([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSearchQuery]);

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
    (async () => {
      try {
        const data = await fetchSessionData(viewState.activeAgentKey, viewState.activeSessionSlug);
        setSession(data);
      } catch {
        setSessionError("Session not found");
        setSession(null);
      } finally {
        setSessionLoading(false);
      }
    })();
    return () => ac.abort();
  }, [sessionFetchKey, viewState.activeAgentKey, viewState.activeSessionSlug, viewState.mode]);

  useEffect(() => {
    const unsubscribe = subscribeSessionUpdates((event) => {
      void syncLiveUpdate(event);
    });

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
      setSelectedSidebarSessionId(
        (current) => current ?? visibleSidebarSessions[0]?.session.id ?? null,
      );
      return;
    }

    setSelectedSidebarSessionId(null);
  }, [
    isSearchMode,
    searchResults.length,
    viewState.mode,
    viewState.activeSessionSlug,
    visibleSidebarSessions,
  ]);

  useEffect(() => {
    if (viewState.mode !== "session") return;
    const containingGroup = sidebarGroups.find((group) =>
      group.sessions.some((session) => session.id === viewState.activeSessionSlug),
    );
    if (!containingGroup) return;
    setExpandedGroups((prev) => {
      if (prev.has(containingGroup.key)) return prev;
      const next = new Set(prev);
      next.add(containingGroup.key);
      return next;
    });
  }, [sidebarGroups, viewState.activeSessionSlug, viewState.mode]);

  useEffect(() => {
    if (!selectedSidebarSessionId) return;
    const node = sidebarItemRefs.current.get(selectedSidebarSessionId);
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedSidebarSessionId]);

  useEffect(() => {
    if (!isSearchMode) return;
    const selectedResult = searchResults[selectedSearchIndex];
    if (!selectedResult) return;
    const key = `${selectedResult.agentName}/${selectedResult.session.id}`;
    searchResultRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [isSearchMode, searchResults, selectedSearchIndex]);

  // Build landing data
  const landingSessions = useMemo<LandingSession[]>(() => {
    return sessions.map((s) => {
      const agentKey = s.slug.split("/")[0]?.toLowerCase() || "unknown";
      return {
        ...s,
        agentKey,
        sessionSlug: s.id,
        fullPath: s.slug,
      };
    });
  }, [sessions]);

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

  // Header
  let headerTitle = "CodeSesh";
  let headerSubtitle = "Select an agent to browse sessions";
  if (viewState.mode === "root") {
    headerTitle = isSearchMode ? "Search" : "Dashboard";
    headerSubtitle = isSearchMode
      ? searchLoading
        ? `Searching for "${activeSearchQuery}"`
        : `${searchResults.length} matches for "${activeSearchQuery}"`
      : dashboard
        ? `${dashboard.totals.sessions.toLocaleString("en-US")} total sessions across ${dashboard.perAgent.length} agents`
        : "Aggregated view across all agents";
  }
  if (isSearchMode && viewState.mode !== "root") {
    headerTitle = "Search";
    headerSubtitle = searchLoading
      ? `Searching for "${activeSearchQuery}"`
      : `${searchResults.length} matches for "${activeSearchQuery}"`;
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
      headerSubtitle = `ID: #${session.id.slice(0, 8)} · Updated ${formatRelativeTime(updated)}`;
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

  const breadcrumbItems = useMemo<BreadcrumbItem[]>(() => {
    if (isSearchMode) {
      return [{ label: "Search" }];
    }

    const dashboardCrumb: BreadcrumbItem = {
      label: "Dashboard",
      to: viewState.mode === "root" ? undefined : "/",
    };

    if (viewState.mode === "root") {
      return [{ label: "Dashboard" }];
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
  }, [activeAgent, activeAgentKey, isSearchMode, session?.title, viewState]);

  // Content
  let content: ReactNode;
  if (loading) {
    content = <SessionDetailSkeleton />;
  } else if (isSearchMode) {
    content = (
      <SearchResultsPanel
        query={activeSearchQuery}
        loading={searchLoading}
        results={searchResults}
        agentNameMap={agentNameMap}
        onOpenResult={() => setActiveSearchQuery("")}
        selectedIndex={selectedSearchIndex}
        registerResultRef={(key, node) => {
          if (node) searchResultRefs.current.set(key, node);
          else searchResultRefs.current.delete(key);
        }}
      />
    );
  } else if (error) {
    content = (
      <div className="mx-auto max-w-4xl rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]">
        {error}
      </div>
    );
  } else if (viewState.mode === "root") {
    content = dashboard ? (
      <Dashboard
        data={dashboard}
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
    ) : (
      <DetailLanding
        type="global"
        sessions={landingSessions}
        agentItems={landingAgentItems}
        isBookmarked={isSessionBookmarked}
        onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
      />
    );
  } else if (viewState.mode === "agent" && activeAgentKey) {
    const agentSessions = landingSessions.filter((s) => s.agentKey === activeAgentKey);
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
          sessions={landingSessions.filter((s) => s.agentKey === viewState.activeAgentKey)}
          agentItems={landingAgentItems}
          activeAgentKey={viewState.activeAgentKey}
          attemptedSessionSlug={viewState.activeSessionSlug}
          isBookmarked={isSessionBookmarked}
          onToggleBookmark={(session) => toggleSessionBookmark(session, session.agentKey)}
        />
      );
    } else {
      content = <SessionDetail session={session} highlightQuery={detailHighlightQuery} />;
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
  }

  function dismissShortcutHint() {
    setShortcutHintDismissed(true);
    try {
      window.localStorage.setItem(SHORTCUT_HINT_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures and keep the UI usable.
    }
  }

  const handleGlobalKeydown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing) return;

    const target = event.target;
    const inEditable = isEditableTarget(target);
    const key = event.key;

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
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }

    if (key === "Escape") {
      event.preventDefault();
      if (activeSearchQuery) {
        setActiveSearchQuery("");
        setDraftSearchQuery("");
        return;
      }
      if (viewState.mode === "session" && viewState.activeAgentKey) {
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
        setActiveSearchQuery("");
        navigate(`/${result.agentName.toLowerCase()}/${result.session.id}`, {
          state: { searchQuery: activeSearchQuery },
        });
      }
      return;
    }

    if (!activeAgentKey || sidebarGroups.length === 0) return;

    const selectGroupBoundary = (direction: "start" | "end") => {
      const group = direction === "start" ? sidebarGroups[0] : sidebarGroups.at(-1);
      if (!group) return;
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.add(group.key);
        return next;
      });
      const session = direction === "start" ? group.sessions[0] : group.sessions.at(-1);
      if (session) setSelectedSidebarSessionId(session.id);
    };

    const moveSidebarSelection = (offset: number) => {
      dismissShortcutHint();
      if (visibleSidebarSessions.length === 0) {
        selectGroupBoundary(offset >= 0 ? "start" : "end");
        return;
      }
      const currentIndex = visibleSidebarSessions.findIndex(
        (entry) => entry.session.id === selectedSidebarSessionId,
      );
      const baseIndex =
        currentIndex >= 0 ? currentIndex : offset >= 0 ? -1 : visibleSidebarSessions.length;
      const nextIndex = Math.max(
        0,
        Math.min(baseIndex + offset, visibleSidebarSessions.length - 1),
      );
      setSelectedSidebarSessionId(visibleSidebarSessions[nextIndex]?.session.id ?? null);
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
      selectGroupBoundary("start");
      return;
    }
    if (key === "G") {
      event.preventDefault();
      dismissShortcutHint();
      selectGroupBoundary("end");
      return;
    }
    if (key === "Enter") {
      const selected = visibleSidebarSessions.find(
        (entry) => entry.session.id === selectedSidebarSessionId,
      );
      if (!selected) return;
      event.preventDefault();
      dismissShortcutHint();
      navigate(`/${activeAgentKey}/${selected.session.id}`);
      return;
    }
    if (key === "l") {
      const selected =
        visibleSidebarSessions.find((entry) => entry.session.id === selectedSidebarSessionId) ??
        (sidebarGroups[0]
          ? { session: sidebarGroups[0].sessions[0]!, groupKey: sidebarGroups[0].key }
          : null);
      if (!selected) return;
      event.preventDefault();
      dismissShortcutHint();
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.add(selected.groupKey);
        return next;
      });
      setSelectedSidebarSessionId(selected.session.id);
      return;
    }
    if (key === "h") {
      const selected = visibleSidebarSessions.find(
        (entry) => entry.session.id === selectedSidebarSessionId,
      );
      if (!selected) return;
      event.preventDefault();
      dismissShortcutHint();
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.delete(selected.groupKey);
        return next;
      });
      const currentGroupIndex = sidebarGroups.findIndex((group) => group.key === selected.groupKey);
      const fallbackGroup =
        sidebarGroups[currentGroupIndex - 1] ?? sidebarGroups[currentGroupIndex + 1] ?? null;
      const fallbackSession = fallbackGroup
        ? (visibleSidebarSessions.find((entry) => entry.groupKey === fallbackGroup.key)?.session ??
          fallbackGroup.sessions[0])
        : null;
      setSelectedSidebarSessionId(fallbackSession?.id ?? null);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, []);

  return (
    <div className="console-ui h-screen overflow-hidden bg-[var(--console-bg)] text-[var(--console-text)]">
      <header className="h-14 shrink-0 border-b border-[var(--console-border)] bg-white/85 backdrop-blur-sm">
        <div className="grid h-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 text-[var(--console-text)]">
            <img src="/logo.svg?v=3" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
            <span className="console-mono text-sm font-semibold uppercase tracking-[0.05em]">
              CodeSesh
            </span>
          </Link>
          <form
            className="mx-auto flex w-full max-w-[560px] items-center justify-center gap-2"
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
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setShortcutHelpOpen(true);
                dismissShortcutHint();
              }}
              className="console-mono rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
              title="Show keyboard shortcuts"
            >
              ? Shortcuts
            </button>
            {formatWindowLabel(appConfig) ? (
              <span
                className="console-mono rounded-sm border border-[var(--console-border)] bg-white px-2 py-1 text-xs text-[var(--console-text)]"
                title="Time window applied to agent counts, dashboard, and session list"
              >
                {formatWindowLabel(appConfig)}
              </span>
            ) : null}
            <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-muted)]">
              v{__APP_VERSION__}
            </span>
          </div>
        </div>
      </header>

      <div className="flex h-[calc(100vh-56px)] min-h-0">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--console-border)] bg-[var(--console-sidebar-bg)] lg:flex">
          <div className="console-scrollbar flex-1 space-y-8 overflow-y-auto px-4 py-6">
            <section>
              <h3 className="console-mono mb-3 text-xs font-bold uppercase text-[var(--console-text)]">
                NAVIGATION
              </h3>
              <ul className="space-y-1">
                <li>
                  <Link
                    to="/"
                    className={`flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left transition-colors ${
                      viewState.mode === "root"
                        ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                        : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                    }`}
                  >
                    <img src="/logo.svg?v=3" alt="Dashboard" className="size-3.5 rounded-[2px]" />
                    <span className="console-mono line-clamp-1 flex-1 text-xs">Dashboard</span>
                  </Link>
                </li>
                {agents.map((agent) => {
                  const key = agent.name.toLowerCase();
                  const isSelected = key === activeAgentKey;
                  const config = ModelConfig.agents[key];
                  return (
                    <li key={agent.name}>
                      <Link
                        to={`/${key}`}
                        className={`ml-4 flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left transition-colors ${
                          isSelected
                            ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                            : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                        }`}
                      >
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
                          {agent.count}
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {agents.length === 0 && !loading && (
                  <li>
                    <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                      No agents found
                    </span>
                  </li>
                )}
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
                {activeAgentKey ? (
                  <span className="ml-2 text-[10px] font-normal text-[var(--console-muted)]">
                    Navigate j k · Open Enter
                  </span>
                ) : null}
              </h3>
              {!activeAgentKey ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  Select an agent
                </span>
              ) : sidebarSessions.length === 0 ? (
                <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
                  No sessions yet
                </span>
              ) : (
                <div className="space-y-2">
                  {sidebarGroups.map((group) => {
                    const isExpanded = expandedGroups.has(group.key);
                    return (
                      <div key={group.key}>
                        {/* Folder header */}
                        <button
                          onClick={() => toggleGroup(group.key)}
                          className="console-mono flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)]"
                          title={group.key === "__unknown__" ? undefined : group.key}
                        >
                          <span className="shrink-0 text-[10px]">{isExpanded ? "▼" : "▶"}</span>
                          <span className="line-clamp-1 font-semibold">{group.label}</span>
                          <span className="ml-auto shrink-0 text-[11px]">
                            {group.sessions.length}
                          </span>
                        </button>
                        {/* Sessions under this folder */}
                        {isExpanded && (
                          <ul className="mt-0.5 space-y-0.5 pl-3">
                            {group.sessions.map((item) => {
                              const isActive =
                                viewState.mode === "session" &&
                                viewState.activeSessionSlug === item.id;
                              return (
                                <li key={item.id}>
                                  <div
                                    className={`relative flex items-start gap-2 rounded-sm border px-2 py-1.5 text-xs transition-colors ${
                                      isActive
                                        ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-0.5 before:bg-[var(--console-accent)]"
                                        : selectedSidebarSessionId === item.id
                                          ? "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-text)]"
                                          : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                                    }`}
                                  >
                                    <Link
                                      ref={(node) => {
                                        if (node) sidebarItemRefs.current.set(item.id, node);
                                        else sidebarItemRefs.current.delete(item.id);
                                      }}
                                      to={`/${activeAgentKey}/${item.id}`}
                                      title={item.title}
                                      className="console-mono line-clamp-1 min-w-0 flex-1"
                                    >
                                      {item.title}
                                    </Link>
                                    {activeAgentKey === "claudecode" ? (
                                      <CopyResumeButton
                                        sessionId={item.id}
                                        directory={item.directory}
                                        className="relative z-10"
                                      />
                                    ) : null}
                                    <BookmarkButton
                                      active={isSessionBookmarked(activeAgentKey, item.id)}
                                      onToggle={() => toggleSessionBookmark(item, activeAgentKey)}
                                      className="relative z-10"
                                    />
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
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
                      : "Landing"}
                </span>
                <h1 className="console-mono text-xl font-semibold tracking-tight text-[var(--console-text)]">
                  {headerTitle}
                </h1>
              </div>
              <p className="console-mono mt-1 text-xs text-[var(--console-muted)]">
                {headerSubtitle}
              </p>
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
              </div>
              {liveNotice ? (
                <p className="console-mono mt-2 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
                  {liveNotice}
                </p>
              ) : null}
            </div>
          </section>

          <section className="console-scrollbar bg-grid min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <ErrorBoundary>{content}</ErrorBoundary>
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

function SearchResultsPanel({
  query,
  loading,
  results,
  agentNameMap,
  onOpenResult,
  selectedIndex,
  registerResultRef,
}: {
  query: string;
  loading: boolean;
  results: SearchResult[];
  agentNameMap: Map<string, string>;
  onOpenResult: () => void;
  selectedIndex: number;
  registerResultRef: (key: string, node: HTMLAnchorElement | null) => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="animate-pulse rounded-sm border border-[var(--console-border)] bg-white/80 p-4"
          >
            <div className="h-3 w-32 rounded bg-[var(--console-surface-muted)]" />
            <div className="mt-3 h-4 w-2/3 rounded bg-[var(--console-surface-muted)]" />
            <div className="mt-2 h-3 w-full rounded bg-[var(--console-surface-muted)]" />
            <div className="mt-1 h-3 w-5/6 rounded bg-[var(--console-surface-muted)]" />
          </div>
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--console-border)] bg-white/80 p-6">
        <h2 className="console-mono text-sm font-semibold text-[var(--console-text)]">
          No matches
        </h2>
        <p className="console-mono mt-2 text-xs text-[var(--console-muted)]">Query: {query}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="console-mono text-[11px] text-[var(--console-muted)]">
        Navigate j k · Open Enter · Exit Esc
      </div>
      {results.map((result, index) => {
        const agentKey = result.agentName.toLowerCase();
        const agentLabel = agentNameMap.get(agentKey) ?? result.agentName;
        const resultKey = `${result.agentName}/${result.session.id}`;

        return (
          <Link
            key={resultKey}
            ref={(node) => registerResultRef(resultKey, node)}
            to={`/${agentKey}/${result.session.id}`}
            state={{ searchQuery: query }}
            onClick={onOpenResult}
            className={`rounded-sm border bg-white/85 p-4 transition-colors hover:border-[var(--console-border-strong)] hover:bg-white ${
              index === selectedIndex
                ? "border-[var(--console-border-strong)]"
                : "border-[var(--console-border)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--console-muted)]">
                {agentLabel}
              </span>
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                {result.session.directory}
              </span>
            </div>
            <h2 className="console-mono mt-3 text-sm font-semibold text-[var(--console-text)]">
              {result.session.title}
            </h2>
            <p
              className="console-mono mt-2 text-xs leading-6 text-[var(--console-muted)] [&_mark]:bg-[var(--console-accent)] [&_mark]:px-0.5 [&_mark]:text-white"
              dangerouslySetInnerHTML={{
                __html: toSafeSnippetHtml(result.snippet || result.session.title),
              }}
            />
          </Link>
        );
      })}
    </div>
  );
}
