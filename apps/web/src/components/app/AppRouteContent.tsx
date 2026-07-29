import { lazy, Suspense, useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { DetailLanding, type LandingAgentItem, type LandingSession } from "../DetailLanding";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";

// Each surface owns its heavy dependencies — markdown, syntax highlighting and
// the receipt reach the browser when their route does, not on first paint.
const Dashboard = lazy(() => import("../Dashboard").then((m) => ({ default: m.Dashboard })));
const ProjectsOverview = lazy(() =>
  import("../Projects").then((m) => ({ default: m.ProjectsOverview })),
);
const ProjectDashboardView = lazy(() =>
  import("../Projects").then((m) => ({ default: m.ProjectDashboardView })),
);
const SessionDetail = lazy(() =>
  import("../SessionDetail").then((m) => ({ default: m.SessionDetail })),
);
const SearchResultsPanel = lazy(() =>
  import("./SearchResultsPanel").then((m) => ({ default: m.SearchResultsPanel })),
);

/** Keeps a failed chunk load contained to the surface that needed it. */
function LazySurface({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<SessionDetailSkeleton />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
import type {
  AgentInfo,
  BookmarkRecord,
  DashboardData,
  ApiProjectGroup,
  SessionHead,
} from "../../lib/api";
import type * as Api from "../../lib/api";
import type { AgentCatalog } from "../../lib/agents";
import type { ViewState } from "../../lib/view-state";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";

interface SessionDetailModel {
  session: Api.SessionDetail | null;
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
  sessions: BookmarkRecord[];
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  toggleBookmark: (session: BookmarkRecord) => void;
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
  projects: ApiProjectGroup[];
  landingSessions: LandingSession[];
  sessionsByAgent: Map<string, LandingSession[]>;
  activeProject: ApiProjectGroup | null;
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
        <LazySurface>
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
        </LazySurface>
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
        <LazySurface>
          <Dashboard
            data={dashboard}
            agentCatalog={agentCatalog}
            projects={projects}
            bookmarkedSessions={bookmarks.sessions}
            isBookmarked={bookmarks.isBookmarked}
            onToggleBookmark={(item) => {
              if (!("bookmarkedAt" in item)) {
                bookmarks.toggleSessionBookmark(item.session, item.reference.agentName);
                return;
              }
              bookmarks.toggleBookmark(item);
            }}
          />
        </LazySurface>
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
    return (
      <LazySurface>
        <ProjectsOverview projects={projects} agentCatalog={agentCatalog} />
      </LazySurface>
    );
  }
  if (viewState.mode === "project") {
    return (
      <LazySurface>
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
      </LazySurface>
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
          attemptedSessionId={viewState.activeSessionId}
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
        <LazySurface>
          <SessionDetail
            key={`${sessionDetail.session.reference.agentName}/${sessionDetail.session.reference.sessionId}`}
            session={sessionDetail.session}
            agentCatalog={agentCatalog}
            highlightQuery={detailHighlightQuery}
          />
        </LazySurface>
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
