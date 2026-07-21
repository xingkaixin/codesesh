import { useMemo, type Dispatch, type SetStateAction } from "react";
import { Dashboard } from "../Dashboard";
import { DetailLanding, type LandingAgentItem, type LandingSession } from "../DetailLanding";
import { ProjectDashboardView, ProjectsOverview } from "../Projects";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetail } from "../SessionDetail";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";
import type {
  AgentInfo,
  BookmarkedSessionSnapshot,
  DashboardData,
  ProjectGroup,
  SessionData,
  SessionHead,
} from "../../lib/api";
import type { AgentCatalog } from "../../lib/agents";
import type { ViewState } from "../../lib/view-state";
import { SearchResultsPanel } from "./SearchResultsPanel";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";

interface SessionDetailModel {
  session: SessionData | null;
  loading: boolean;
  error: string | null;
}

interface ProjectDashboardModel {
  dashboard: DashboardData | null;
  loading: boolean;
  error: string | null;
  selectedAgent?: string;
  onChangeAgent: (agent?: string) => void;
}

interface SearchContentModel {
  active: boolean;
  query: string;
  state: SearchLoadState;
  projectOptions: SearchProjectOption[];
  filters: SearchFilterState;
  onChangeFilters: Dispatch<SetStateAction<SearchFilterState>>;
  onClose: () => void;
  onRetry: () => void;
  selectedIndex: number;
  registerResultRef: (key: string, node: HTMLAnchorElement | null) => void;
}

interface BookmarkContentModel {
  sessions: BookmarkedSessionSnapshot[];
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  toggleBookmark: (session: BookmarkedSessionSnapshot) => void;
  toggleSessionBookmark: (session: SessionHead, agentKey: string) => void;
}

interface AppRouteContentProps {
  loading: boolean;
  error: string | null;
  viewState: ViewState;
  detailHighlightQuery: string;
  agents: AgentInfo[];
  agentCatalog: AgentCatalog;
  agentNameMap: ReadonlyMap<string, string>;
  projects: ProjectGroup[];
  landingSessions: LandingSession[];
  sessionsByAgent: Map<string, LandingSession[]>;
  activeProject: ProjectGroup | null;
  activeProjectSessions: LandingSession[];
  dashboard: DashboardData | null;
  sessionDetail: SessionDetailModel;
  projectDashboard: ProjectDashboardModel;
  search: SearchContentModel;
  bookmarks: BookmarkContentModel;
}

export function AppRouteContent({
  loading,
  error,
  viewState,
  detailHighlightQuery,
  agents,
  agentCatalog,
  agentNameMap,
  projects,
  landingSessions,
  sessionsByAgent,
  activeProject,
  activeProjectSessions,
  dashboard,
  sessionDetail,
  projectDashboard,
  search,
  bookmarks,
}: AppRouteContentProps) {
  const landingAgentItems = useMemo<LandingAgentItem[]>(
    () =>
      agents.map((agent) => ({
        key: agent.name.toLowerCase(),
        name: agent.displayName,
        icon: agent.icon,
        iconColored: agent.iconColored,
        count: agent.count,
      })),
    [agents],
  );
  if (loading) return <SessionDetailSkeleton />;
  if (search.active) {
    const resultCount = search.state.status === "loaded" ? search.state.results.length : 0;
    return (
      <RenderProfiler
        id="SearchResultsPanel"
        detail={{ results: resultCount, loading: search.state.status === "loading" }}
      >
        <SearchResultsPanel
          query={search.query}
          state={search.state}
          agentNameMap={agentNameMap}
          agents={agents}
          projects={search.projectOptions}
          filters={search.filters}
          onChangeFilters={search.onChangeFilters}
          onOpenResult={search.onClose}
          onRetry={search.onRetry}
          selectedIndex={search.selectedIndex}
          registerResultRef={search.registerResultRef}
        />
      </RenderProfiler>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-4xl rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]">
        {error}
      </div>
    );
  }
  if (viewState.mode === "root") {
    return dashboard ? (
      <RenderProfiler
        id="Dashboard"
        detail={{ sessions: dashboard.totals.sessions, projects: projects.length }}
      >
        <Dashboard
          data={dashboard}
          agentCatalog={agentCatalog}
          projects={projects}
          bookmarkedSessions={bookmarks.sessions}
          isBookmarked={bookmarks.isBookmarked}
          onToggleBookmark={(session, agentKey) => {
            if ("agentName" in session) {
              bookmarks.toggleSessionBookmark(session, agentKey ?? session.agentName.toLowerCase());
              return;
            }
            bookmarks.toggleBookmark(session);
          }}
        />
      </RenderProfiler>
    ) : (
      <DetailLanding
        type="global"
        agentCatalog={agentCatalog}
        sessions={landingSessions}
        agentItems={landingAgentItems}
        isBookmarked={bookmarks.isBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  if (viewState.mode === "projects") {
    return <ProjectsOverview projects={projects} agentCatalog={agentCatalog} />;
  }
  if (viewState.mode === "project") {
    return (
      <ProjectDashboardView
        project={activeProject}
        agentCatalog={agentCatalog}
        projectKey={viewState.activeProjectKey}
        dashboard={projectDashboard.dashboard}
        loading={projectDashboard.loading}
        error={projectDashboard.error}
        sessions={activeProjectSessions}
        activeAgent={projectDashboard.selectedAgent}
        onChangeAgent={projectDashboard.onChangeAgent}
        isBookmarked={bookmarks.isBookmarked}
        onToggleSessionBookmark={bookmarks.toggleSessionBookmark}
      />
    );
  }
  if (viewState.mode === "agent") {
    return (
      <DetailLanding
        type="agent"
        agentCatalog={agentCatalog}
        sessions={sessionsByAgent.get(viewState.activeAgentKey) ?? []}
        agentItems={landingAgentItems}
        activeAgentKey={viewState.activeAgentKey}
        isBookmarked={bookmarks.isBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  if (viewState.mode === "session") {
    if (sessionDetail.loading) return <SessionDetailSkeleton />;
    if (sessionDetail.error || !sessionDetail.session) {
      return (
        <DetailLanding
          type="missing-session"
          agentCatalog={agentCatalog}
          sessions={sessionsByAgent.get(viewState.activeAgentKey) ?? []}
          agentItems={landingAgentItems}
          activeAgentKey={viewState.activeAgentKey}
          attemptedSessionSlug={viewState.activeSessionSlug}
          isBookmarked={bookmarks.isBookmarked}
          onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
        />
      );
    }
    return (
      <RenderProfiler
        id="SessionDetail"
        detail={{
          messages: sessionDetail.session.messages.length,
          session: sessionDetail.session.id,
        }}
      >
        <SessionDetail
          session={sessionDetail.session}
          agentCatalog={agentCatalog}
          highlightQuery={detailHighlightQuery}
        />
      </RenderProfiler>
    );
  }
  if (viewState.mode === "missingAgent") {
    return (
      <DetailLanding
        type="missing-agent"
        agentCatalog={agentCatalog}
        sessions={landingSessions}
        agentItems={landingAgentItems}
        attemptedAgentKey={viewState.attemptedKey}
        isBookmarked={bookmarks.isBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  return <div className="text-sm text-[var(--console-muted)]">Invalid route.</div>;
}
