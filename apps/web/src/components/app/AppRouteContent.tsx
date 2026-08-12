import { lazy, Suspense, useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLocation } from "react-router-dom";
import { DetailLanding, type LandingAgentItem, type LandingSession } from "../DetailLanding";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";

// Each surface owns its heavy dependencies — markdown, syntax highlighting and
// the receipt reach the browser when their route does, not on first paint.
const OverviewScreen = lazy(() =>
  import("../overview/OverviewScreen").then((m) => ({ default: m.OverviewScreen })),
);
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
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<SessionDetailSkeleton />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
import type { AgentInfo, AppConfig, ApiProjectGroup, SessionHead } from "../../lib/api";
import type * as Api from "../../lib/api";
import type { AgentCatalog } from "../../lib/agents";
import type { TimeWindowPreset } from "../../lib/time-window";
import type { ViewState } from "../../lib/view-state";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";
import { getSessionRouteKey } from "../../lib/session-indexes";

interface SessionDetailModel {
  session: Api.SessionDetail | null;
  loading: boolean;
  error: string | null;
}

/** The overview owns its scope and its own request; the shell only lends it the
 *  loaded window and the app-wide time-window presets. */
interface OverviewModel {
  window: AppConfig["window"] | null;
  rangePreset: TimeWindowPreset;
  onRangeChange: (preset: TimeWindowPreset) => void;
  onSelectCustom: (from: string, to: string) => void;
}

interface ProjectAgentFilterModel {
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
  isBookmarked: (agentKey: string, sessionId: string) => boolean;
  toggleSessionBookmark: (session: SessionHead, agentKey: string) => void;
}

interface AppRouteContentProps {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  viewState: ViewState;
  detailHighlightQuery: string;
  agents: AgentInfo[];
  agentCatalog: AgentCatalog;
  agentNameMap: ReadonlyMap<string, string>;
  projects: ApiProjectGroup[];
  landingSessions: LandingSession[];
  sessions?: SessionHead[];
  sessionsByAgent: Map<string, LandingSession[]>;
  activeProject: ApiProjectGroup | null;
  activeProjectSessions: LandingSession[];
  overview: OverviewModel;
  sessionDetail: SessionDetailModel;
  projectAgentFilter: ProjectAgentFilterModel;
  search: SearchContentModel;
  bookmarks: BookmarkContentModel;
}

export function AppRouteContent({
  loading,
  error,
  onRetry,
  viewState,
  detailHighlightQuery,
  agents,
  agentCatalog,
  agentNameMap,
  projects,
  landingSessions,
  sessions = [],
  sessionsByAgent,
  activeProject,
  activeProjectSessions,
  overview,
  sessionDetail,
  projectAgentFilter,
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
      <div
        role="alert"
        className="mx-auto max-w-4xl rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]"
      >
        <p>{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="console-mono mt-4 rounded-sm border border-[var(--console-error-border)] px-3 py-1.5 text-xs motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          Retry
        </button>
      </div>
    );
  }
  if (viewState.mode === "root") {
    return (
      <RenderProfiler id="OverviewScreen" detail={{ projects: projects.length }}>
        <LazySurface>
          <OverviewScreen
            window={overview.window}
            agentCatalog={agentCatalog}
            rangePreset={overview.rangePreset}
            onRangeChange={overview.onRangeChange}
            onSelectCustom={overview.onSelectCustom}
          />
        </LazySurface>
      </RenderProfiler>
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
          sessions={activeProjectSessions}
          activeAgent={projectAgentFilter.selectedAgent}
          onChangeAgent={projectAgentFilter.onChangeAgent}
          timeWindow={overview.window}
          rangePreset={overview.rangePreset}
          onRangeChange={overview.onRangeChange}
          onSelectCustom={overview.onSelectCustom}
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
    const currentSession = sessionDetail.session;
    const childSessions = sessions.filter(
      (candidate) =>
        candidate.parent_reference &&
        getSessionRouteKey(
          candidate.parent_reference.agentName,
          candidate.parent_reference.sessionId,
        ) === getSessionRouteKey(currentSession.reference.agentName, currentSession.id),
    );
    return (
      <RenderProfiler
        id="SessionDetail"
        detail={{
          messages: currentSession.messages.length,
          session: currentSession.id,
        }}
      >
        <LazySurface>
          <SessionDetail
            key={`${currentSession.reference.agentName}/${currentSession.reference.sessionId}`}
            session={currentSession}
            agentCatalog={agentCatalog}
            highlightQuery={detailHighlightQuery}
            childSessions={childSessions}
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
