import { useFluidHover } from "../../hooks/useFluidHover";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { lazy, Suspense, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { sourceName } from "../nodes/SourceBadge";
import type { BookmarkView, ApiProjectGroup, SessionHead, SourceNode } from "../../lib/api";
import { useScanStatus } from "../../hooks/useScanStatus";
import { useSidebarKeyboardNavigation } from "../../hooks/useSidebarKeyboardNavigation";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { getSessionBookmarkKey } from "../../lib/bookmarks";
import {
  getSessionRoutePath,
  getSessionRouteKey,
  type SidebarSessionLookup,
} from "../../lib/session-indexes";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { getProjectGroupIdentity, getProjectIdentityKey, getProjectPath } from "../../lib/projects";
import type { ViewState } from "../../lib/view-state";
import { AgentIcon } from "../AgentIcon";
import { DrawerDialog } from "../DrawerDialog";
import { RenderProfiler } from "../RenderProfiler";
import { ResourceLoadFailure } from "../ResourceLoadFailure";
import { SessionActionsMenu } from "../SessionActionsMenu";
import { Folder, LayoutDashboard, PanelLeftClose, Search } from "../ui/icons";
import { Kbd } from "../ui/kbd";
import { Link } from "react-router-dom";
import type { Theme } from "../../hooks/useUiPreferences";
import { cn } from "../../lib/utils";
import { SidebarFooter } from "./SidebarFooter";

declare const __APP_VERSION__: string;

const SessionTreeSidebar = lazy(() =>
  import("../SessionTreeSidebar").then((module) => ({ default: module.SessionTreeSidebar })),
);

const SIDEBAR_PROJECT_LIMIT = 8;

function navItemClass(isSelected: boolean, size: "md" | "sm" = "md"): string {
  return cn(
    "flex w-full items-center gap-2.5 rounded-lg pr-2.5 pl-2 text-left text-[var(--console-text)] motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
    size === "md" ? "h-9 text-[13px]" : "h-8 text-xs",
    isSelected
      ? "bg-[var(--console-sidebar-accent)] font-medium"
      : "hover:bg-[var(--console-sidebar-accent)]/60",
  );
}

function NavCount({ value }: { value: number }) {
  return (
    <span className="ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--console-sidebar-accent)] px-[5px] text-[10px] font-semibold text-[var(--console-muted)]">
      {value}
    </span>
  );
}

function NavLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1 text-[11px] text-[var(--console-muted)]">
      {children}
    </div>
  );
}

function ScanAwareEmptyState({ scanning, empty }: { scanning: string; empty: string }) {
  useLocale();

  const scanStatus = useScanStatus();
  return (
    <span className="block px-3 py-1.5 text-xs text-[var(--console-muted)]">
      {scanStatus?.active ? scanning : empty}
    </span>
  );
}

function ProjectNavList({
  projects,
  selectedProjectNavigationId,
}: {
  projects: ApiProjectGroup[];
  selectedProjectNavigationId: string | null;
}) {
  useLocale();

  const visibleProjects = projects.slice(0, SIDEBAR_PROJECT_LIMIT);
  const selectedProject = selectedProjectNavigationId
    ? projects.find((project) => {
        const identity = getProjectGroupIdentity(project);
        return getProjectIdentityKey(identity) === selectedProjectNavigationId;
      })
    : undefined;
  if (selectedProject && !visibleProjects.includes(selectedProject)) {
    visibleProjects.push(selectedProject);
  }

  return (
    <>
      {visibleProjects.map((project) => {
        const projectIdentity = getProjectGroupIdentity(project);
        const isSelected = selectedProjectNavigationId === getProjectIdentityKey(projectIdentity);
        return (
          <li key={`${project.identityKind}:${project.identityKey}`}>
            <Link
              data-fluid-item
              to={getProjectPath(projectIdentity)}
              data-active={isSelected ? "true" : undefined}
              aria-current={isSelected ? "page" : undefined}
              className={cn("min-w-0", navItemClass(isSelected, "sm"))}
            >
              <Folder
                aria-hidden="true"
                className="size-[18px] shrink-0 text-[var(--console-text-secondary)]"
              />
              <span className="console-mono min-w-0 flex-1 truncate">{project.displayName}</span>
              <NavCount value={project.sessionCount} />
            </Link>
          </li>
        );
      })}
    </>
  );
}

export interface AppSidebarViewModel {
  sidebarCollapsed: boolean;
  mobileNavigationOpen: boolean;
  viewState: ViewState;
  agentCatalog: AgentCatalog;
  projects: ApiProjectGroup[];
  projectCount: number;
  projectsError: string | null;
  projectsLoading: boolean;
  selectedProjectNavigationId: string | null;
  bookmarkedSessions: BookmarkView[];
  bookmarksError: string | null;
  bookmarksLoading: boolean;
  sidebarSessions: SessionHead[];
  sidebarSessionLookup: SidebarSessionLookup;
  bookmarkedSidebarSessionReferences: Set<string>;
  sourceNodes?: SourceNode[];
  isSearchMode: boolean;
  shortcutHelpOpen: boolean;
  hubEnabled: boolean;
  sessionCount: number;
  theme: Theme;
}

export interface AppSidebarActions {
  onCollapse: () => void;
  onMobileNavigationOpenChange: (open: boolean) => void;
  onToggleBookmark: (session: BookmarkView) => void;
  onSelectFlatSidebarSession: (session: SessionHead) => void;
  onCopySessionAsMarkdown: (session: SessionHead) => void;
  onToggleSidebarSessionBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  onRenameBookmarkedSession: (session: BookmarkView) => void;
  onRetryProjects: () => void;
  onRetryBookmarks: () => void;
  onOpenSearch: () => void;
  onChangeTheme: (theme: Theme) => void;
  onShowShortcuts: () => void;
}

function SidebarFrame({
  collapsed,
  mobileOpen,
  onMobileOpenChange,
  children,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  useLocale();

  useEffect(() => {
    if (!mobileOpen || typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 1025px)");
    const closeOnDesktop = () => {
      if (desktop.matches) onMobileOpenChange(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [mobileOpen, onMobileOpenChange]);

  if (mobileOpen) {
    return (
      <DrawerDialog
        open
        onOpenChange={onMobileOpenChange}
        title={t("Navigation")}
        variant="mobile"
        side="left"
      >
        {children}
      </DrawerDialog>
    );
  }

  return (
    <aside
      aria-label={t("Primary navigation")}
      className={`w-60 shrink-0 flex-col pb-2 pl-2 ${collapsed ? "hidden" : "hidden min-[1025px]:flex"}`}
    >
      {children}
    </aside>
  );
}

export function AppSidebar({
  model: {
    sidebarCollapsed,
    mobileNavigationOpen,
    viewState,
    agentCatalog,
    projects,
    projectCount,
    projectsError,
    projectsLoading,
    selectedProjectNavigationId,
    bookmarkedSessions,
    bookmarksError,
    bookmarksLoading,
    sidebarSessions,
    sidebarSessionLookup,
    bookmarkedSidebarSessionReferences,
    sourceNodes,
    isSearchMode,
    shortcutHelpOpen,
    hubEnabled,
    sessionCount,
    theme,
  },
  actions: {
    onCollapse,
    onMobileNavigationOpenChange,
    onToggleBookmark,
    onSelectFlatSidebarSession,
    onCopySessionAsMarkdown,
    onToggleSidebarSessionBookmark,
    onRenameSession,
    onRenameBookmarkedSession,
    onRetryProjects,
    onRetryBookmarks,
    onOpenSearch,
    onChangeTheme,
    onShowShortcuts,
  },
}: {
  model: AppSidebarViewModel;
  actions: AppSidebarActions;
}) {
  useLocale();
  const hoverRef = useFluidHover<HTMLUListElement>();

  const activeSessionReference =
    viewState.mode === "session"
      ? getSessionRouteKey(
          viewState.activeAgentKey,
          viewState.activeSessionId,
          viewState.sourceNodeId,
        )
      : null;
  const isOverviewSelected = viewState.mode === "root";
  const isProjectsSelected = viewState.mode === "projects";
  const multipleSources =
    new Set(sidebarSessions.map((session) => session.reference.sourceNodeId ?? "local")).size > 1;
  const sessionSourceLabel = useMemo(
    () =>
      multipleSources
        ? (session: SessionHead) =>
            sourceName(session.reference.sourceNodeId ?? "local", sourceNodes)
        : undefined,
    [multipleSources, sourceNodes],
  );
  const { selectedSessionReference, selectSession } = useSidebarKeyboardNavigation({
    viewState,
    sessions: sidebarSessions,
    sessionLookup: sidebarSessionLookup,
    isSearchMode,
    shortcutHelpOpen,
    onOpenSession: onSelectFlatSidebarSession,
  });
  const handleSelectSession = useCallback(
    (session: SessionHead) => {
      selectSession(session);
      onSelectFlatSidebarSession(session);
    },
    [onSelectFlatSidebarSession, selectSession],
  );

  return (
    <SidebarFrame
      collapsed={sidebarCollapsed}
      mobileOpen={mobileNavigationOpen}
      onMobileOpenChange={onMobileNavigationOpenChange}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 pr-3 pl-3">
        <Link
          to="/"
          aria-label={t("CodeSesh overview")}
          className="inline-flex min-w-0 items-center gap-2 rounded-sm text-[15px] font-bold text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <img src="/logo.svg?v=3" alt="" className="size-[22px] rounded-sm" />
          <span className="console-display">CodeSesh</span>
          <small className="console-mono text-[10px] font-medium text-[var(--console-muted)]">
            v{__APP_VERSION__}
          </small>
        </Link>
        {!mobileNavigationOpen ? (
          <button
            type="button"
            aria-expanded="true"
            aria-label={t("Collapse sidebar")}
            title={t("Collapse sidebar")}
            onClick={onCollapse}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--console-muted)] motion-hover hover:bg-[var(--console-sidebar-accent)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <PanelLeftClose className="size-4" />
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onOpenSearch}
        className="mr-2 mb-1 flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)]/60 pr-2 pl-2.5 text-xs text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        <Search aria-hidden="true" className="size-3.5" />
        <span className="flex-1 text-left">{t("Search Sessions")}</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="console-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-2">
        <nav aria-label={t("Navigation")} className="flex flex-col gap-0.5">
          <Link
            to="/"
            aria-current={isOverviewSelected ? "page" : undefined}
            className={navItemClass(isOverviewSelected)}
          >
            <LayoutDashboard
              aria-hidden="true"
              className="size-[18px] shrink-0 text-[var(--console-text-secondary)]"
            />
            <span className="min-w-0 flex-1 truncate">{t("Dashboard")}</span>
          </Link>
          <Link
            to="/projects"
            aria-current={isProjectsSelected ? "page" : undefined}
            className={navItemClass(isProjectsSelected)}
          >
            <Folder
              aria-hidden="true"
              className="size-[18px] shrink-0 text-[var(--console-text-secondary)]"
            />
            <span className="min-w-0 flex-1 truncate">{t("All projects")}</span>
            <NavCount value={projectCount} />
          </Link>
        </nav>

        <section aria-labelledby="sidebar-recent-projects">
          <NavLabel>
            <h3 id="sidebar-recent-projects" className="font-normal">
              {t("Recent projects")}
            </h3>
            <span className="console-mono">{t("Sessions")}</span>
          </NavLabel>
          <ul ref={hoverRef} data-fluid-hover="y" className="flex flex-col gap-0.5">
            <ProjectNavList
              projects={projects}
              selectedProjectNavigationId={selectedProjectNavigationId}
            />
            {projectsError ? (
              <li>
                <ResourceLoadFailure
                  title={t("Couldn't load projects.")}
                  message={projectsError}
                  onRetry={onRetryProjects}
                  className="px-3 py-2"
                />
              </li>
            ) : projects.length === 0 && !projectsLoading ? (
              <li>
                <ScanAwareEmptyState
                  scanning={t("Scanning projects...")}
                  empty={t("No projects found")}
                />
              </li>
            ) : null}
          </ul>
          {projects.length > 0 ? (
            <p className="px-3 pt-0.5 text-[10px] text-[var(--console-muted)]">
              {t("Most recent first")}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="sidebar-bookmarks">
          <NavLabel>
            <h3 id="sidebar-bookmarks" className="font-normal">
              {t("Bookmarks")}
            </h3>
            {bookmarkedSessions.length > 0 ? (
              <span className="console-mono">{bookmarkedSessions.length}</span>
            ) : null}
          </NavLabel>
          {bookmarksError ? (
            <ResourceLoadFailure
              title={t("Couldn't load bookmarks.")}
              message={bookmarksError}
              onRetry={onRetryBookmarks}
              className="mb-2 px-3 py-2"
            />
          ) : null}
          {bookmarkedSessions.length === 0 && bookmarksLoading ? (
            <span className="block px-3 py-1.5 text-xs text-[var(--console-muted)]">
              {t("Loading bookmarks...")}
            </span>
          ) : bookmarkedSessions.length === 0 && !bookmarksError ? (
            <span className="block px-3 py-1.5 text-xs text-[var(--console-muted)]">
              {t("No bookmarks yet")}
            </span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {bookmarkedSessions.map((bookmark) => {
                const { reference } = bookmark;
                const isActive =
                  viewState.mode === "session" &&
                  viewState.activeAgentKey === reference.agentName &&
                  viewState.activeSessionId === reference.sessionId &&
                  (viewState.sourceNodeId ?? "local") === (reference.sourceNodeId ?? "local");
                const agent = findAgent(agentCatalog, reference.agentName);
                const available = bookmark.availability === "available";
                const unavailableTitle = available ? undefined : bookmark.display_title;
                const availabilityLabel =
                  bookmark.availability === "agent-unavailable"
                    ? t("Agent unavailable")
                    : t("Session unavailable");
                const title = available
                  ? getSessionDisplayTitle(bookmark.session)
                  : (unavailableTitle ?? reference.sessionId);
                const unavailableDetail = unavailableTitle
                  ? `${agent?.displayName ?? reference.agentName} · ${reference.sessionId} · ${availabilityLabel}`
                  : `${agent?.displayName ?? reference.agentName} · ${availabilityLabel}`;
                const label = (
                  <>
                    {agent?.icon ? (
                      <AgentIcon
                        icon={agent.icon}
                        iconColored={agent.iconColored}
                        alt=""
                        className="size-4 shrink-0 object-contain"
                      />
                    ) : (
                      <span aria-hidden="true" className="size-4 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs">{title}</span>
                      <span className="truncate text-[10px] leading-tight text-[var(--console-muted)]">
                        {available
                          ? (agent?.displayName ?? reference.agentName)
                          : unavailableDetail}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={getSessionBookmarkKey(reference)}>
                    <div
                      data-active={isActive ? "true" : undefined}
                      className={cn(
                        "flex min-h-10 items-center gap-1 rounded-lg pr-1 pl-2 motion-hover",
                        isActive
                          ? "bg-[var(--console-sidebar-accent)] font-medium text-[var(--console-text)]"
                          : "text-[var(--console-text)] hover:bg-[var(--console-sidebar-accent)]/60",
                        available ? undefined : "text-[var(--console-muted)]",
                      )}
                    >
                      {available ? (
                        <Link
                          to={getSessionRoutePath(bookmark.session)}
                          aria-current={isActive ? "page" : undefined}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1.5 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                        >
                          {label}
                        </Link>
                      ) : (
                        <div
                          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5"
                          aria-disabled="true"
                        >
                          {label}
                        </div>
                      )}
                      <SessionActionsMenu
                        bookmarked
                        onCopyAsMarkdown={
                          available ? () => onCopySessionAsMarkdown(bookmark.session) : undefined
                        }
                        onRename={() => onRenameBookmarkedSession(bookmark)}
                        onToggleBookmark={() => onToggleBookmark(bookmark)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Sessions belong to a project; without one there is nothing to list. */}
        {selectedProjectNavigationId ? (
          <section aria-labelledby="sidebar-sessions">
            <NavLabel>
              <h3 id="sidebar-sessions" className="font-normal">
                {t("Sessions")}
              </h3>
              {sidebarSessions.length > 0 ? (
                <span
                  className="inline-flex items-center gap-1"
                  title={t("Navigate j k · Open Enter")}
                >
                  <Kbd>J</Kbd>
                  <Kbd>K</Kbd>
                </span>
              ) : null}
            </NavLabel>
            {sidebarSessions.length === 0 ? (
              <ScanAwareEmptyState
                scanning={t("Scanning sessions...")}
                empty={t("No sessions yet")}
              />
            ) : (
              <RenderProfiler id="SessionTreeSidebar" detail={{ sessions: sidebarSessions.length }}>
                <Suspense fallback={null}>
                  <SessionTreeSidebar
                    sessions={sidebarSessions}
                    activeSessionReference={activeSessionReference}
                    selectedSessionReference={selectedSessionReference}
                    onSelectSession={handleSelectSession}
                    bookmarkedSessionReferences={bookmarkedSidebarSessionReferences}
                    onCopySessionAsMarkdown={onCopySessionAsMarkdown}
                    onToggleBookmark={onToggleSidebarSessionBookmark}
                    onRenameSession={onRenameSession}
                    groupByProject={false}
                    sourceLabel={sessionSourceLabel}
                  />
                </Suspense>
              </RenderProfiler>
            )}
          </section>
        ) : null}
      </div>
      <SidebarFooter
        hubEnabled={hubEnabled}
        sessionCount={sessionCount}
        theme={theme}
        onChangeTheme={onChangeTheme}
        onShowShortcuts={onShowShortcuts}
      />
    </SidebarFrame>
  );
}
