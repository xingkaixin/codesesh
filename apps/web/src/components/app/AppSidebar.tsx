import type {
  AgentInfo,
  BookmarkedSessionSnapshot,
  ProjectGroup,
  ScanStatusEvent,
  SessionHead,
} from "../../lib/api";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { getSessionBookmarkKey } from "../../lib/bookmarks";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { formatAgentScanProgress } from "../../lib/scan-format";
import { getProjectGroupIdentity, getProjectIdentityKey, getProjectPath } from "../../lib/projects";
import type { ViewState } from "../../lib/view-state";
import { RenderProfiler } from "../RenderProfiler";
import { SessionActionsMenu } from "../SessionActionsMenu";
import { SessionTreeSidebar } from "../SessionTreeSidebar";
import { Link } from "react-router-dom";
import { BrowseByToggle } from "./BrowseByToggle";
import { SidebarFlatSessionList } from "./SidebarFlatSessionList";
import type { BrowseBy } from "./types";

function AgentNavList({
  agents,
  activeAgentKey,
  scanStatus,
  isScanActive,
}: {
  agents: AgentInfo[];
  activeAgentKey: string | null;
  scanStatus: ScanStatusEvent | null;
  isScanActive: boolean;
}) {
  return (
    <>
      {agents.map((agent) => {
        const key = agent.name.toLowerCase();
        const isSelected = key === activeAgentKey;
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
            {agent.icon && (
              <img src={agent.icon} alt={agent.displayName} className="size-3.5 object-contain" />
            )}
            <span className="console-mono line-clamp-1 flex-1 text-xs">{agent.displayName}</span>
            <span className="console-mono text-[11px] text-[var(--console-muted)]">
              {agentProgress ?? agent.count}
            </span>
          </>
        );
        return (
          <li key={agent.name}>
            {disabled ? (
              <span className={className} title="Available after this agent scan completes">
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
      })}
    </>
  );
}

function ProjectNavList({
  projects,
  selectedProjectNavigationId,
  onSelectProject,
}: {
  projects: ProjectGroup[];
  selectedProjectNavigationId: string | null;
  onSelectProject: (identity: ReturnType<typeof getProjectGroupIdentity>) => void;
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
              onClick={() => onSelectProject(projectIdentity)}
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
    </>
  );
}

export interface AppSidebarViewModel {
  sidebarCollapsed: boolean;
  browseBy: BrowseBy;
  isScanActive: boolean;
  viewState: ViewState;
  agents: AgentInfo[];
  agentCatalog: AgentCatalog;
  activeAgentKey: string | null;
  scanStatus: ScanStatusEvent | null;
  projects: ProjectGroup[];
  selectedProjectNavigationId: string | null;
  loading: boolean;
  bookmarkedSessions: BookmarkedSessionSnapshot[];
  sidebarSessions: SessionHead[];
  selectedSidebarSessionId: string | null;
  bookmarkedSidebarSessionIds: Set<string>;
}

export interface AppSidebarActions {
  onChangeBrowseBy: (value: BrowseBy) => void;
  onSelectProject: (identity: ReturnType<typeof getProjectGroupIdentity>) => void;
  onToggleBookmark: (session: BookmarkedSessionSnapshot) => void;
  onSelectFlatSidebarSession: (session: SessionHead) => void;
  onToggleSidebarSessionBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  onRenameBookmarkedSession: (session: BookmarkedSessionSnapshot) => void;
  onSelectTreeSidebarSession: (sessionId: string) => void;
}

export function AppSidebar({
  model: {
    sidebarCollapsed,
    browseBy,
    isScanActive,
    viewState,
    agents,
    agentCatalog,
    activeAgentKey,
    scanStatus,
    projects,
    selectedProjectNavigationId,
    loading,
    bookmarkedSessions,
    sidebarSessions,
    selectedSidebarSessionId,
    bookmarkedSidebarSessionIds,
  },
  actions: {
    onChangeBrowseBy,
    onSelectProject,
    onToggleBookmark,
    onSelectFlatSidebarSession,
    onToggleSidebarSessionBookmark,
    onRenameSession,
    onRenameBookmarkedSession,
    onSelectTreeSidebarSession,
  },
}: {
  model: AppSidebarViewModel;
  actions: AppSidebarActions;
}) {
  return (
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
            onChange={onChangeBrowseBy}
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
            {browseBy === "agents" ? (
              <AgentNavList
                agents={agents}
                activeAgentKey={activeAgentKey}
                scanStatus={scanStatus}
                isScanActive={isScanActive}
              />
            ) : (
              <ProjectNavList
                projects={projects}
                selectedProjectNavigationId={selectedProjectNavigationId}
                onSelectProject={onSelectProject}
              />
            )}
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
                const agent = findAgent(agentCatalog, session.agentKey);
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
                            alt={agent.displayName}
                            className="mt-0.5 size-3.5 shrink-0 object-contain"
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <span className="console-mono line-clamp-1 block text-xs">
                            {getSessionDisplayTitle(session)}
                          </span>
                          <span className="console-mono mt-0.5 line-clamp-1 block text-[10px] text-[var(--console-muted)]">
                            {agent?.displayName ?? session.agentKey}
                          </span>
                        </div>
                      </Link>
                      <SessionActionsMenu
                        bookmarked
                        onRename={() => onRenameBookmarkedSession(session)}
                        onToggleBookmark={() => onToggleBookmark(session)}
                      />
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
              agentCatalog={agentCatalog}
              activeSessionId={viewState.mode === "session" ? viewState.activeSessionSlug : null}
              selectedSessionId={selectedSidebarSessionId}
              bookmarkedSessionIds={bookmarkedSidebarSessionIds}
              onSelectSession={onSelectFlatSidebarSession}
              onToggleBookmark={onToggleSidebarSessionBookmark}
              onRenameSession={onRenameSession}
            />
          ) : (
            <RenderProfiler id="SessionTreeSidebar" detail={{ sessions: sidebarSessions.length }}>
              <SessionTreeSidebar
                sessions={sidebarSessions}
                activeSessionId={viewState.mode === "session" ? viewState.activeSessionSlug : null}
                selectedSessionId={selectedSidebarSessionId}
                onSelectSession={onSelectTreeSidebarSession}
                bookmarkedSessionIds={bookmarkedSidebarSessionIds}
                onToggleBookmark={onToggleSidebarSessionBookmark}
                onRenameSession={onRenameSession}
              />
            </RenderProfiler>
          )}
        </section>
      </div>
    </aside>
  );
}
