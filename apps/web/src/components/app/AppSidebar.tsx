import type { BookmarkView, ApiProjectGroup, SessionHead } from "../../lib/api";
import { useScanStatus } from "../../hooks/useScanStatus";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { getSessionBookmarkKey } from "../../lib/bookmarks";
import { getSessionRoutePath, getSessionRouteKey } from "../../lib/session-indexes";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { getProjectGroupIdentity, getProjectIdentityKey, getProjectPath } from "../../lib/projects";
import type { ViewState } from "../../lib/view-state";
import { AgentIcon } from "../AgentIcon";
import { RenderProfiler } from "../RenderProfiler";
import { SessionActionsMenu } from "../SessionActionsMenu";
import { SessionTreeSidebar } from "../SessionTreeSidebar";
import { PanelLeftClose } from "../ui/icons";
import { Link } from "react-router-dom";

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
  return (
    <>
      {projects.map((project) => {
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
  viewState: ViewState;
  agentCatalog: AgentCatalog;
  projects: ApiProjectGroup[];
  selectedProjectNavigationId: string | null;
  loading: boolean;
  bookmarkedSessions: BookmarkView[];
  sidebarSessions: SessionHead[];
  selectedSidebarSessionReference: string | null;
  bookmarkedSidebarSessionReferences: Set<string>;
}

export interface AppSidebarActions {
  onCollapse: () => void;
  onToggleBookmark: (session: BookmarkView) => void;
  onSelectFlatSidebarSession: (session: SessionHead) => void;
  onToggleSidebarSessionBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  onRenameBookmarkedSession: (session: BookmarkView) => void;
}

export function AppSidebar({
  model: {
    sidebarCollapsed,
    viewState,
    agentCatalog,
    projects,
    selectedProjectNavigationId,
    loading,
    bookmarkedSessions,
    sidebarSessions,
    selectedSidebarSessionReference,
    bookmarkedSidebarSessionReferences,
  },
  actions: {
    onCollapse,
    onToggleBookmark,
    onSelectFlatSidebarSession,
    onToggleSidebarSessionBookmark,
    onRenameSession,
    onRenameBookmarkedSession,
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

  return (
    <aside
      className={`w-64 shrink-0 flex-col border-r border-[var(--console-border)] bg-[var(--console-sidebar-bg)] ${
        sidebarCollapsed ? "hidden" : "hidden lg:flex"
      }`}
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
            </li>
            <ProjectNavList
              projects={projects}
              selectedProjectNavigationId={selectedProjectNavigationId}
            />
            {projects.length === 0 && !loading ? (
              <li>
                <ScanAwareEmptyState scanning="Scanning projects..." empty="No projects found" />
              </li>
            ) : null}
          </ul>
        </section>

        <section>
          <h3 className="console-eyebrow mb-3">BOOKMARKS</h3>
          {bookmarkedSessions.length === 0 ? (
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
                  selectedSessionReference={selectedSidebarSessionReference}
                  onSelectSession={onSelectFlatSidebarSession}
                  bookmarkedSessionReferences={bookmarkedSidebarSessionReferences}
                  onToggleBookmark={onToggleSidebarSessionBookmark}
                  onRenameSession={onRenameSession}
                  groupByProject={false}
                />
              </RenderProfiler>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
