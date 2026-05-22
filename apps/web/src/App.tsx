declare const __APP_VERSION__: string;

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ModelConfig } from "./config";
import type {
  AgentInfo,
  AppConfig,
  BookmarkedSessionSnapshot,
  DashboardData,
  FileActivityKind,
  SearchRequestOptions,
  SearchResult,
  SessionHead,
  SessionData,
  ScanStatusEvent,
  SessionsUpdatedEvent,
  SmartTag,
  ProjectGroup,
  ProjectIdentityKind,
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
import { SMART_TAG_LABELS, SmartTagChips } from "./components/SmartTagChips";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  mergeBookmarksWithSessions,
  toBookmarkedSessionSnapshot,
} from "./lib/bookmarks";
import {
  decodeProjectRouteKey,
  getProjectIdentityKey,
  getProjectPath,
  isProjectIdentityKind,
  type ProjectRouteIdentity,
} from "./lib/projects";
import {
  buildSessionIndexes,
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionRouteKey,
} from "./lib/session-indexes";

type BrowseBy = "agents" | "projects";

type ViewState =
  | { mode: "root"; activeAgentKey: null; activeSessionSlug: null }
  | { mode: "projects"; activeAgentKey: null; activeSessionSlug: null }
  | {
      mode: "project";
      activeAgentKey: null;
      activeSessionSlug: null;
      activeProjectKind: ProjectIdentityKind;
      activeProjectKey: string;
    }
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
  if (segments[0]?.toLowerCase() === "projects") {
    if (segments.length === 1) {
      return { mode: "projects", activeAgentKey: null, activeSessionSlug: null };
    }
    if (segments.length === 3) {
      try {
        const kind = decodeURIComponent(segments[1]!);
        if (!isProjectIdentityKind(kind)) {
          return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
        }
        return {
          mode: "project",
          activeAgentKey: null,
          activeSessionSlug: null,
          activeProjectKind: kind,
          activeProjectKey: decodeProjectRouteKey(segments[2]!),
        };
      } catch {
        return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
      }
    }
    return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
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

function formatSearchSubtitle(query: string, loading: boolean, count: number) {
  if (loading) return query ? `Searching for "${query}"` : "Loading recent sessions";
  return query ? `${count} matches for "${query}"` : `${count} recent sessions`;
}

function formatScanStatusLabel(status: ScanStatusEvent | null): string | null {
  if (!status?.active) return null;

  const completed = status.completedAgents.length;
  const total = status.totalAgents;
  const current = status.scanningAgents[0];
  const currentStatus = current ? status.agentStatuses[current] : null;
  const itemProgress =
    currentStatus?.total && currentStatus.processed != null
      ? ` · ${currentStatus.processed}/${currentStatus.total}`
      : "";
  const agentProgress =
    total > 0
      ? current
        ? ` · ${current}${itemProgress} · ${completed}/${total} agents ready`
        : ` · ${completed}/${total} agents ready`
      : "";

  if (status.phase === "initializing") {
    return `First-run setup: indexing all local sessions${agentProgress}. Your selected time window appears after this finishes.`;
  }
  if (status.phase === "indexing") return "Preparing local session index";

  if (total > 0) {
    return current
      ? `Checking for new or changed sessions · ${current}${itemProgress} · ${completed}/${total} agents ready`
      : `Checking for new or changed sessions · ${completed}/${total} agents ready`;
  }
  return "Checking for new or changed sessions";
}

function formatAgentScanProgress(status: ScanStatusEvent | null, agentName: string): string | null {
  const agentStatus = status?.agentStatuses[agentName];
  if (!agentStatus || agentStatus.status === "complete") return null;
  if (agentStatus.total && agentStatus.processed != null) {
    return `${agentStatus.processed}/${agentStatus.total}`;
  }
  return agentStatus.status === "scanning" ? "Scanning" : "Pending";
}

function getAgentDisplayCount(
  status: ScanStatusEvent | null,
  agentName: string,
  fallback: number,
): number {
  const agentStatus = status?.agentStatuses[agentName];
  return agentStatus?.status === "complete" && agentStatus.sessions != null
    ? agentStatus.sessions
    : fallback;
}

function getProjectGroupIdentity(project: ProjectGroup): ProjectRouteIdentity {
  return { kind: project.identityKind, key: project.identityKey };
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

function compareSessionActivityDesc(a: SessionHead, b: SessionHead): number {
  return (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created);
}

function applyLiveSessionUpdate(
  sessions: SessionHead[],
  event: SessionsUpdatedEvent,
): SessionHead[] | null {
  if (!event.changedSessionHeads || !event.removedSessionRefs) return null;

  const byKey = new Map(
    sessions.map((sessionItem) => [
      getSessionRouteKey(getSessionAgentKey(sessionItem), sessionItem.id),
      sessionItem,
    ]),
  );

  for (const { agentName, sessionId } of event.removedSessionRefs) {
    byKey.delete(getSessionRouteKey(agentName, sessionId));
  }

  for (const { agentName, session: sessionItem } of event.changedSessionHeads) {
    byKey.set(getSessionRouteKey(agentName, sessionItem.id), sessionItem);
  }

  return [...byKey.values()].sort(compareSessionActivityDesc);
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

type CostRangeId = "paid" | "one_plus" | "ten_plus";

interface SearchFilterState {
  agent?: string;
  projectKey?: string;
  tag?: SmartTag;
  tool?: string;
  fileKind?: FileActivityKind;
  costRange?: CostRangeId;
}

interface SearchProjectOption {
  key: string;
  label: string;
  count: number;
  showCount?: boolean;
}

const SHORTCUT_HINT_STORAGE_KEY = "codesesh.shortcuts-hint-dismissed";

const SMART_TAG_OPTIONS: SmartTag[] = [
  "bugfix",
  "refactoring",
  "feature-dev",
  "testing",
  "docs",
  "git-ops",
  "build-deploy",
  "exploration",
  "planning",
];

const SEARCH_TOOL_OPTIONS = ["apply_patch", "bash", "read", "edit", "grep"] as const;

const FILE_ACTIVITY_OPTIONS: Array<{ kind: FileActivityKind; label: string }> = [
  { kind: "read", label: "Read" },
  { kind: "edit", label: "Edit" },
  { kind: "write", label: "Write" },
  { kind: "delete", label: "Delete" },
];

const COST_RANGE_OPTIONS: Array<{
  id: CostRangeId;
  label: string;
  costMin: number;
}> = [
  { id: "paid", label: "Cost > $0", costMin: 0.000001 },
  { id: "one_plus", label: "Cost >= $1", costMin: 1 },
  { id: "ten_plus", label: "Cost >= $10", costMin: 10 },
];

const SEARCH_MATCH_LABELS: Record<SearchResult["matchType"], string> = {
  recent: "Recent",
  title: "Title",
  user_message: "User message",
  assistant_reply: "Assistant reply",
  tool_output: "Tool output",
  file_path: "File path",
};

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

function BrowseByToggle({
  value,
  onChange,
  projectsDisabled = false,
}: {
  value: BrowseBy;
  onChange: (value: BrowseBy) => void;
  projectsDisabled?: boolean;
}) {
  const options: Array<{ value: BrowseBy; label: string }> = [
    { value: "projects", label: "Projects" },
    { value: "agents", label: "Agents" },
  ];

  return (
    <div role="radiogroup" aria-label="Browse by" className="grid gap-1.5">
      {options.map((option) => {
        const active = value === option.value;
        const disabled = option.value === "projects" && projectsDisabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`console-mono flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left text-xs transition-colors ${
              disabled
                ? "cursor-not-allowed border-transparent text-[var(--console-muted)] opacity-45"
                : active
                  ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                  : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
            }`}
            title={
              disabled ? "Project grouping is available after the current scan finishes" : undefined
            }
          >
            <span
              className={`flex size-3 shrink-0 items-center justify-center rounded-full border ${
                active ? "border-[var(--console-accent)]" : "border-[var(--console-border-strong)]"
              }`}
            >
              {active ? (
                <span className="size-1.5 rounded-full bg-[var(--console-accent)]" />
              ) : null}
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SidebarFlatSessionList({
  sessions,
  activeSessionId,
  selectedSessionId,
  bookmarkedSessionIds,
  onSelectSession,
  onToggleBookmark,
}: {
  sessions: SessionHead[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  bookmarkedSessionIds: Set<string>;
  onSelectSession: (session: SessionHead) => void;
  onToggleBookmark: (session: SessionHead) => void;
}) {
  return (
    <div className="console-scrollbar h-[min(560px,calc(100vh-410px))] min-h-56 overflow-y-auto">
      <ul className="space-y-1">
        {sessions.map((sessionItem) => {
          const agentKey = getSessionAgentKey(sessionItem);
          const agentConfig = ModelConfig.agents[agentKey];
          const active = activeSessionId === sessionItem.id;
          const selected = selectedSessionId === sessionItem.id;
          return (
            <li key={sessionItem.slug}>
              <div
                className={`flex items-start gap-1 rounded-sm border px-2 py-1.5 transition-colors ${
                  active || selected
                    ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                    : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectSession(sessionItem)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {agentConfig?.icon ? (
                      <img
                        src={agentConfig.icon}
                        alt={agentConfig.name}
                        className="size-3.5 shrink-0 object-contain"
                      />
                    ) : null}
                    <span className="console-mono line-clamp-1 text-xs text-[var(--console-text)]">
                      {sessionItem.title}
                    </span>
                  </span>
                  <span className="console-mono mt-0.5 block truncate text-[10px] text-[var(--console-muted)]">
                    {formatRelativeTime(sessionItem.time_updated ?? sessionItem.time_created)}
                  </span>
                </button>
                <BookmarkButton
                  active={bookmarkedSessionIds.has(sessionItem.id)}
                  onToggle={() => onToggleBookmark(sessionItem)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
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
  }

  function toggleSessionBookmark(session: SessionHead, agentKey: string) {
    toggleBookmark(toBookmarkedSessionSnapshot(session, agentKey));
  }

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
          <Link to="/" className="flex items-center gap-2 text-[var(--console-text)]">
            <img src="/logo.svg?v=3" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
            <span className="console-mono text-sm font-semibold uppercase tracking-[0.05em]">
              CodeSesh
            </span>
          </Link>
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
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--console-border)] bg-[var(--console-sidebar-bg)] lg:flex">
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
                  onSelectSession={(sessionItem) => {
                    setSelectedSidebarSessionId(sessionItem.id);
                    navigate(`/${sessionItem.slug}`);
                  }}
                  onToggleBookmark={(sessionItem) =>
                    toggleSessionBookmark(sessionItem, getSessionAgentKey(sessionItem))
                  }
                />
              ) : (
                <SessionTreeSidebar
                  sessions={sidebarSessions}
                  activeSessionId={
                    viewState.mode === "session" ? viewState.activeSessionSlug : null
                  }
                  selectedSessionId={selectedSidebarSessionId}
                  onSelectSession={(sessionId) => {
                    setSelectedSidebarSessionId(sessionId);
                    const selected = sidebarSessionLookup.byId.get(sessionId);
                    if (selected) navigate(`/${selected.slug}`);
                  }}
                  bookmarkedSessionIds={bookmarkedSidebarSessionIds}
                  onToggleBookmark={(sessionItem) =>
                    toggleSessionBookmark(sessionItem, getSessionAgentKey(sessionItem))
                  }
                />
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
  agents,
  projects,
  filters,
  onChangeFilters,
  onOpenResult,
  selectedIndex,
  registerResultRef,
}: {
  query: string;
  loading: boolean;
  results: SearchResult[];
  agentNameMap: Map<string, string>;
  agents: AgentInfo[];
  projects: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
  onOpenResult: () => void;
  selectedIndex: number;
  registerResultRef: (key: string, node: HTMLAnchorElement | null) => void;
}) {
  const filterBar = (
    <SearchFilterBar
      agents={agents}
      projects={projects}
      filters={filters}
      onChangeFilters={onChangeFilters}
    />
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
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
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {filterBar}
        <div className="rounded-sm border border-[var(--console-border)] bg-white/80 p-6">
          <h2 className="console-mono text-sm font-semibold text-[var(--console-text)]">
            {query ? "No matches" : "No recent sessions"}
          </h2>
          {query ? (
            <p className="console-mono mt-2 text-xs text-[var(--console-muted)]">Query: {query}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {filterBar}
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
              <span className="console-mono rounded-sm border border-[var(--console-border)] bg-white px-1.5 py-0.5 text-[10px] uppercase text-[var(--console-muted)]">
                {SEARCH_MATCH_LABELS[result.matchType]}
              </span>
              <span className="console-mono text-[11px] text-[var(--console-muted)]">
                {result.session.directory}
              </span>
            </div>
            <h2 className="console-mono mt-3 text-sm font-semibold text-[var(--console-text)]">
              {result.session.title}
            </h2>
            <SmartTagChips tags={result.session.smart_tags} className="mt-2" />
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

function SearchFilterBar({
  agents,
  projects,
  filters,
  onChangeFilters,
}: {
  agents: AgentInfo[];
  projects: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
}) {
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const setFilter = <K extends keyof SearchFilterState>(key: K, value: SearchFilterState[K]) => {
    onChangeFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white/85 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Scope
        </span>
        <FilterChip
          active={!filters.projectKey}
          label="All"
          onClick={() => onChangeFilters((current) => ({ ...current, projectKey: undefined }))}
        />
        {projects.map((project) => (
          <FilterChip
            key={project.key}
            active={filters.projectKey === project.key}
            label={
              project.showCount === false ? project.label : `${project.label} · ${project.count}`
            }
            onClick={() => setFilter("projectKey", project.key)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Agent
        </span>
        <FilterChip
          active={!filters.agent}
          label="All Agents"
          onClick={() => onChangeFilters((current) => ({ ...current, agent: undefined }))}
        />
        {agents.map((agent) => (
          <FilterChip
            key={agent.name}
            active={filters.agent === agent.name}
            label={agent.displayName}
            onClick={() => setFilter("agent", agent.name)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Tag
        </span>
        {SMART_TAG_OPTIONS.map((tag) => (
          <FilterChip
            key={tag}
            active={filters.tag === tag}
            label={SMART_TAG_LABELS[tag]}
            onClick={() => setFilter("tag", tag)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Signal
        </span>
        {SEARCH_TOOL_OPTIONS.map((tool) => (
          <FilterChip
            key={tool}
            active={filters.tool === tool}
            label={`tool:${tool}`}
            onClick={() => setFilter("tool", tool)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          File Activity
        </span>
        {FILE_ACTIVITY_OPTIONS.map((option) => (
          <FilterChip
            key={option.kind}
            active={filters.fileKind === option.kind}
            label={option.label}
            onClick={() => setFilter("fileKind", option.kind)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="console-mono text-[10px] font-semibold uppercase text-[var(--console-muted)]">
          Cost Range
        </span>
        <FilterChip
          active={!filters.costRange}
          label="Any Cost"
          onClick={() => onChangeFilters((current) => ({ ...current, costRange: undefined }))}
        />
        {COST_RANGE_OPTIONS.map((option) => (
          <FilterChip
            key={option.id}
            active={filters.costRange === option.id}
            label={option.label}
            onClick={() => setFilter("costRange", option.id)}
          />
        ))}
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={() => onChangeFilters({})}
            className="console-mono ml-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[10px] text-[var(--console-muted)] transition-colors hover:bg-white"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`console-mono rounded-sm border px-2 py-1 text-[10px] transition-colors ${
        active
          ? "border-[var(--console-border-strong)] bg-[var(--console-accent)] text-white"
          : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:bg-white"
      }`}
    >
      {label}
    </button>
  );
}
