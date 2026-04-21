declare const __APP_VERSION__: string;

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { ModelConfig } from "./config";
import type {
  AgentInfo,
  AppConfig,
  DashboardData,
  SearchResult,
  SessionHead,
  SessionData,
  SessionsUpdatedEvent,
} from "./lib/api";
import {
  fetchAgents,
  fetchConfig,
  fetchDashboard,
  fetchSearchResults,
  fetchSessions,
  fetchSessionData,
  subscribeSessionUpdates,
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

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<SessionHead[]>([]);
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

  // Load config + agents + sessions + dashboard (all share the same app-level window)
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const config = await fetchConfig();
        setAppConfig(config);
        const [agentList, sessionList, dashboardData] = await Promise.all([
          fetchAgents(),
          fetchSessions(),
          fetchDashboard(config.window.days).catch((err) => {
            console.error("Failed to load dashboard:", err);
            return null;
          }),
        ]);
        setAgents(agentList);
        setSessions(sessionList.sessions);
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
  const detailHighlightQuery =
    isSearchMode
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

  const activeAgentKey = viewState.activeAgentKey;
  const sidebarSessions = useMemo(
    () => (activeAgentKey ? (sessionsByAgent[activeAgentKey] ?? []) : []),
    [activeAgentKey, sessionsByAgent],
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
      <Dashboard data={dashboard} />
    ) : (
      <DetailLanding type="global" sessions={landingSessions} agentItems={landingAgentItems} />
    );
  } else if (viewState.mode === "agent" && activeAgentKey) {
    const agentSessions = landingSessions.filter((s) => s.agentKey === activeAgentKey);
    content = (
      <DetailLanding
        type="agent"
        sessions={agentSessions}
        agentItems={landingAgentItems}
        activeAgentKey={activeAgentKey}
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
      />
    );
  } else {
    content = <div className="text-sm text-[var(--console-muted)]">Invalid route.</div>;
  }

  function runSearch() {
    setActiveSearchQuery(draftSearchQuery.trim());
  }

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
                value={draftSearchQuery}
                onChange={(event) => setDraftSearchQuery(event.target.value)}
                placeholder="Search sessions"
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
                SESSIONS
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
                                  <Link
                                    to={`/${activeAgentKey}/${item.id}`}
                                    className={`console-mono relative block rounded-sm border px-2 py-1.5 text-xs transition-colors ${
                                      isActive
                                        ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-0.5 before:bg-[var(--console-accent)]"
                                        : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                                    }`}
                                    title={item.title}
                                  >
                                    <span className="line-clamp-1">{item.title}</span>
                                  </Link>
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
    </div>
  );
}

function SearchResultsPanel({
  query,
  loading,
  results,
  agentNameMap,
  onOpenResult,
}: {
  query: string;
  loading: boolean;
  results: SearchResult[];
  agentNameMap: Map<string, string>;
  onOpenResult: () => void;
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
        <p className="console-mono mt-2 text-xs text-[var(--console-muted)]">
          Query: {query}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {results.map((result) => {
        const agentKey = result.agentName.toLowerCase();
        const agentLabel = agentNameMap.get(agentKey) ?? result.agentName;

        return (
          <Link
            key={`${result.agentName}/${result.session.id}`}
            to={`/${agentKey}/${result.session.id}`}
            state={{ searchQuery: query }}
            onClick={onOpenResult}
            className="rounded-sm border border-[var(--console-border)] bg-white/85 p-4 transition-colors hover:border-[var(--console-border-strong)] hover:bg-white"
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
