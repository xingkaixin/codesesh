import { useCallback, useEffect, type ReactNode } from "react";
import type { BookmarkView, ApiProjectGroup, SessionHead } from "../../lib/api";
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
import { SessionTreeSidebar } from "../SessionTreeSidebar";
import { PanelLeftClose } from "../ui/icons";
import { Link } from "react-router-dom";

const SIDEBAR_PROJECT_LIMIT = 50;

function navItemClass(isSelected: boolean): string {
  return `flex items-center gap-2 rounded-sm px-3 py-1.5 text-left motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
    isSelected
      ? "bg-[var(--brand-soft)] text-[var(--brand)]"
      : "text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)]"
  }`;
}

function ScanAwareEmptyState({ scanning, empty }: { scanning: string; empty: string }) {
  const scanStatus = useScanStatus();
  return (
    <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
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
              to={getProjectPath(projectIdentity)}
              data-active={isSelected ? "true" : undefined}
              className={`min-w-0 ${navItemClass(isSelected)}`}
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
  isSearchMode: boolean;
  shortcutHelpOpen: boolean;
  dismissShortcutHint: () => void;
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
        title="Navigation"
        variant="mobile"
        side="left"
      >
        {children}
      </DrawerDialog>
    );
  }

  return (
    <aside
      aria-label="Primary navigation"
      className={`w-64 shrink-0 flex-col border-r border-[var(--console-border)] bg-[var(--console-sidebar-bg)] ${
        collapsed ? "hidden" : "hidden min-[1025px]:flex"
      }`}
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
    isSearchMode,
    shortcutHelpOpen,
    dismissShortcutHint,
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
  },
}: {
  model: AppSidebarViewModel;
  actions: AppSidebarActions;
}) {
  const activeSessionReference =
    viewState.mode === "session"
      ? getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionId)
      : null;
  const isOverviewSelected = viewState.mode === "root";
  const isProjectsSelected = viewState.mode === "projects";
  const { selectedSessionReference, selectSession } = useSidebarKeyboardNavigation({
    viewState,
    sessions: sidebarSessions,
    sessionLookup: sidebarSessionLookup,
    isSearchMode,
    shortcutHelpOpen,
    dismissShortcutHint,
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
      <div className="console-scrollbar flex-1 space-y-8 overflow-y-auto px-4 py-6">
        <section>
          <ul className="console-scrollbar max-h-[min(320px,calc(100vh-400px))] space-y-1 overflow-y-auto pr-1">
            <li className="flex items-center gap-2">
              <Link
                to="/"
                data-active={isOverviewSelected ? "true" : undefined}
                className={`min-w-0 flex-1 ${navItemClass(isOverviewSelected)}`}
              >
                <img src="/logo.svg?v=3" alt="Dashboard" className="size-3.5 rounded-[2px]" />
                <span className="console-mono line-clamp-1 flex-1 text-xs">Dashboard</span>
              </Link>
              {!mobileNavigationOpen ? (
                <button
                  type="button"
                  aria-expanded="true"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  onClick={onCollapse}
                  className="shrink-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              ) : null}
            </li>
            <li>
              <Link
                to="/projects"
                data-active={isProjectsSelected ? "true" : undefined}
                className={navItemClass(isProjectsSelected)}
              >
                <span className="console-mono min-w-0 flex-1 truncate text-xs">Projects</span>
                <span className="console-mono shrink-0 text-[11px] text-[var(--console-muted)]">
                  {projectCount}
                </span>
              </Link>
            </li>
            <ProjectNavList
              projects={projects}
              selectedProjectNavigationId={selectedProjectNavigationId}
            />
            {projectsError ? (
              <li>
                <ResourceLoadFailure
                  title="Couldn't load projects."
                  message={projectsError}
                  onRetry={onRetryProjects}
                  className="px-3 py-2"
                />
              </li>
            ) : projects.length === 0 && !projectsLoading ? (
              <li>
                <ScanAwareEmptyState scanning="Scanning projects..." empty="No projects found" />
              </li>
            ) : null}
          </ul>
        </section>

        <section>
          <h3 className="console-eyebrow mb-3">BOOKMARKS</h3>
          {bookmarksError ? (
            <ResourceLoadFailure
              title="Couldn't load bookmarks."
              message={bookmarksError}
              onRetry={onRetryBookmarks}
              className="mb-2 px-3 py-2"
            />
          ) : null}
          {bookmarkedSessions.length === 0 && bookmarksLoading ? (
            <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
              Loading bookmarks...
            </span>
          ) : bookmarkedSessions.length === 0 && !bookmarksError ? (
            <span className="console-mono block rounded-sm px-3 py-1.5 text-xs text-[var(--console-muted)]">
              No bookmarks yet
            </span>
          ) : (
            <ul className="space-y-1">
              {bookmarkedSessions.map((bookmark) => {
                const { reference } = bookmark;
                const isActive =
                  viewState.mode === "session" &&
                  viewState.activeAgentKey === reference.agentName &&
                  viewState.activeSessionId === reference.sessionId;
                const agent = findAgent(agentCatalog, reference.agentName);
                const available = bookmark.availability === "available";
                const unavailableTitle = available ? undefined : bookmark.display_title;
                const availabilityLabel =
                  bookmark.availability === "agent-unavailable"
                    ? "Agent unavailable"
                    : "Session unavailable";
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
                        alt={agent.displayName}
                        className="mt-0.5 size-3.5 shrink-0 object-contain"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <span className="console-mono line-clamp-1 block text-xs">{title}</span>
                      <span className="console-mono mt-0.5 line-clamp-1 block text-[10px] text-[var(--console-muted)]">
                        {available
                          ? (agent?.displayName ?? reference.agentName)
                          : unavailableDetail}
                      </span>
                    </div>
                  </>
                );
                return (
                  <li key={getSessionBookmarkKey(reference)}>
                    <div
                      data-active={isActive ? "true" : undefined}
                      className={`flex items-start gap-2 rounded-sm px-2 py-1.5 motion-hover ${
                        isActive
                          ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                          : "text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)]"
                      }`}
                    >
                      {available ? (
                        <Link
                          to={getSessionRoutePath(bookmark.session)}
                          className="flex min-w-0 flex-1 items-start gap-2"
                        >
                          {label}
                        </Link>
                      ) : (
                        <div className="flex min-w-0 flex-1 items-start gap-2" aria-disabled="true">
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
          <section>
            <h3 className="console-eyebrow mb-3">
              SESSIONS
              {sidebarSessions.length > 0 ? (
                <span className="ml-2 text-[10px] font-normal text-[var(--console-muted)]">
                  Navigate j k · Open Enter
                </span>
              ) : null}
            </h3>
            {sidebarSessions.length === 0 ? (
              <ScanAwareEmptyState scanning="Scanning sessions..." empty="No sessions yet" />
            ) : (
              <RenderProfiler id="SessionTreeSidebar" detail={{ sessions: sidebarSessions.length }}>
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
                />
              </RenderProfiler>
            )}
          </section>
        ) : null}
      </div>
    </SidebarFrame>
  );
}
