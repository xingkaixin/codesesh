import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Link, useLocation } from "react-router-dom";
import type { SessionDetailError } from "../../hooks/useSessionDetail";
import type { AgentCatalog } from "../../lib/agents";
import type {
  AgentInfo,
  AppConfig,
  ApiProjectGroup,
  ApiProjectPage,
  SessionDetail,
  SessionHead,
} from "../../lib/api";
import { getSessionRouteKey, type IndexedSession } from "../../lib/session-indexes";
import type { TimeWindowPreset } from "../../lib/time-window";
import type { ViewState } from "../../lib/view-state";
import { DetailLanding, type LandingAgentItem } from "../DetailLanding";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";

const OverviewScreen = lazy(() =>
  import("../overview/OverviewScreen").then((module) => ({ default: module.OverviewScreen })),
);
const ProjectsOverview = lazy(() =>
  import("../Projects").then((module) => ({ default: module.ProjectsOverview })),
);
const ProjectDashboardView = lazy(() =>
  import("../Projects").then((module) => ({ default: module.ProjectDashboardView })),
);
const SessionDetailView = lazy(() =>
  import("../SessionDetail").then((module) => ({ default: module.SessionDetail })),
);
const SearchResultsPanel = lazy(() =>
  import("./SearchResultsPanel").then((module) => ({ default: module.SearchResultsPanel })),
);

function LazySurface({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<SessionDetailSkeleton />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

interface LoadModel {
  loading: boolean;
  error: string | null;
  retry: () => void;
}

interface SessionDetailModel {
  session: SessionDetail | null;
  loading: boolean;
  error: SessionDetailError | null;
  retry: () => void;
}

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
  agentNameMap: ReadonlyMap<string, string>;
  agents: AgentInfo[];
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

interface LandingRouteModel {
  agents: AgentInfo[];
  agentCatalog: AgentCatalog;
  sessions: IndexedSession[];
  bookmarks: BookmarkContentModel;
}

type RootRouteModel = Extract<ViewState, { mode: "root" }> & {
  agentCatalog: AgentCatalog;
  projectCount: number;
  overview: OverviewModel;
};

type ProjectsRouteModel = Extract<ViewState, { mode: "projects" }> & {
  agentCatalog: AgentCatalog;
  projectPage: ApiProjectPage;
  projectsLoad: LoadModel;
  window: AppConfig["window"] | null;
};

type ProjectRouteModel = Extract<ViewState, { mode: "project" }> & {
  agentCatalog: AgentCatalog;
  project: ApiProjectGroup | null;
  projectLoad: LoadModel;
  sessions: IndexedSession[];
  agentFilter: ProjectAgentFilterModel;
  overview: OverviewModel;
};

type AgentRouteModel = Extract<ViewState, { mode: "agent" }> & LandingRouteModel;

type SessionRouteModel = Extract<ViewState, { mode: "session" }> &
  LandingRouteModel & {
    detail: SessionDetailModel;
    detailHighlightQuery: string;
    childSessionsByParentRouteKey: ReadonlyMap<string, SessionHead[]>;
  };

type MissingAgentRouteModel = Extract<ViewState, { mode: "missingAgent" }> & LandingRouteModel;

export type AppRouteModel =
  | RootRouteModel
  | ProjectsRouteModel
  | ProjectRouteModel
  | AgentRouteModel
  | SessionRouteModel
  | MissingAgentRouteModel
  | Extract<ViewState, { mode: "invalidRoute" }>;

interface AppRouteContentProps {
  load: LoadModel;
  search: SearchContentModel;
  route: AppRouteModel;
}

function landingAgentItems(agents: AgentInfo[]): LandingAgentItem[] {
  return agents.map((agent) => ({
    key: agent.name.toLowerCase(),
    name: agent.displayName,
    icon: agent.icon,
    iconColored: agent.iconColored,
    count: agent.count,
  }));
}

function SearchRouteContent({ search }: { search: SearchContentModel }) {
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
          agentNameMap={search.agentNameMap}
          agents={search.agents}
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

function LoadError({ load }: { load: LoadModel }) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-4xl rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6 text-sm text-[var(--console-error)]"
    >
      <p>{load.error}</p>
      <button
        type="button"
        onClick={load.retry}
        className="console-mono mt-4 rounded-sm border border-[var(--console-error-border)] px-3 py-1.5 text-xs motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        Retry
      </button>
    </div>
  );
}

function RootRouteContent({ route }: { route: RootRouteModel }) {
  return (
    <RenderProfiler id="OverviewScreen" detail={{ projects: route.projectCount }}>
      <LazySurface>
        <OverviewScreen
          window={route.overview.window}
          agentCatalog={route.agentCatalog}
          rangePreset={route.overview.rangePreset}
          onRangeChange={route.overview.onRangeChange}
          onSelectCustom={route.overview.onSelectCustom}
        />
      </LazySurface>
    </RenderProfiler>
  );
}

function ProjectsRouteContent({ route }: { route: ProjectsRouteModel }) {
  return (
    <LazySurface>
      <ProjectsOverview
        initialPage={route.projectPage}
        window={route.window}
        agentCatalog={route.agentCatalog}
        loading={route.projectsLoad.loading}
        error={route.projectsLoad.error}
        onRetry={route.projectsLoad.retry}
      />
    </LazySurface>
  );
}

function ProjectRouteContent({ route }: { route: ProjectRouteModel }) {
  return (
    <LazySurface>
      <ProjectDashboardView
        project={route.project}
        loading={route.projectLoad.loading}
        error={route.projectLoad.error}
        onRetry={route.projectLoad.retry}
        agentCatalog={route.agentCatalog}
        projectKey={route.activeProjectKey}
        sessions={route.sessions}
        activeAgent={route.agentFilter.selectedAgent}
        onChangeAgent={route.agentFilter.onChangeAgent}
        timeWindow={route.overview.window}
        rangePreset={route.overview.rangePreset}
        onRangeChange={route.overview.onRangeChange}
        onSelectCustom={route.overview.onSelectCustom}
      />
    </LazySurface>
  );
}

function AgentRouteContent({ route }: { route: AgentRouteModel }) {
  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  const toggleSessionBookmark = route.bookmarks.toggleSessionBookmark;
  const toggleBookmark = useCallback(
    (session: IndexedSession) => toggleSessionBookmark(session, session.reference.agentName),
    [toggleSessionBookmark],
  );
  return (
    <DetailLanding
      type="agent"
      agentCatalog={route.agentCatalog}
      sessions={route.sessions}
      agentItems={agentItems}
      activeAgentKey={route.activeAgentKey}
      isBookmarked={route.bookmarks.isBookmarked}
      onToggleBookmark={toggleBookmark}
    />
  );
}

function SessionRouteContent({ route }: { route: SessionRouteModel }) {
  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  const currentSession = route.detail.session;
  const currentSessionAgentName = currentSession?.reference.agentName;
  const currentSessionId = currentSession?.reference.sessionId;
  const childSessions = useMemo(() => {
    if (!currentSessionAgentName || !currentSessionId) return [];
    return (
      route.childSessionsByParentRouteKey.get(
        getSessionRouteKey(currentSessionAgentName, currentSessionId),
      ) ?? []
    );
  }, [route.childSessionsByParentRouteKey, currentSessionAgentName, currentSessionId]);
  const toggleSessionBookmark = route.bookmarks.toggleSessionBookmark;
  const toggleBookmark = useCallback(
    (session: IndexedSession) => toggleSessionBookmark(session, session.reference.agentName),
    [toggleSessionBookmark],
  );

  if (route.detail.loading) return <SessionDetailSkeleton />;
  if (route.detail.error?.kind === "missing") {
    return (
      <DetailLanding
        type="missing-session"
        agentCatalog={route.agentCatalog}
        sessions={route.sessions}
        agentItems={agentItems}
        activeAgentKey={route.activeAgentKey}
        attemptedSessionId={route.activeSessionId}
        isBookmarked={route.bookmarks.isBookmarked}
        onToggleBookmark={toggleBookmark}
      />
    );
  }
  if (route.detail.error?.kind === "load-failed") {
    return (
      <DetailLanding
        type="load-failed"
        agentCatalog={route.agentCatalog}
        sessions={route.sessions}
        agentItems={agentItems}
        loadFailureMessage={route.detail.error.message}
        isBookmarked={route.bookmarks.isBookmarked}
        onToggleBookmark={toggleBookmark}
        onRetry={route.detail.retry}
      />
    );
  }
  if (!currentSession) return <SessionDetailSkeleton />;
  return (
    <RenderProfiler
      id="SessionDetail"
      detail={{
        messages: currentSession.messages.length,
        session: currentSession.reference.sessionId,
      }}
    >
      <LazySurface>
        <SessionDetailView
          key={`${currentSession.reference.agentName}/${currentSession.reference.sessionId}`}
          session={currentSession}
          agentCatalog={route.agentCatalog}
          highlightQuery={route.detailHighlightQuery}
          childSessions={childSessions}
        />
      </LazySurface>
    </RenderProfiler>
  );
}

function MissingAgentRouteContent({ route }: { route: MissingAgentRouteModel }) {
  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  return (
    <DetailLanding
      type="missing-agent"
      agentCatalog={route.agentCatalog}
      sessions={route.sessions}
      agentItems={agentItems}
      attemptedAgentKey={route.attemptedKey}
      isBookmarked={route.bookmarks.isBookmarked}
      onToggleBookmark={(session) =>
        route.bookmarks.toggleSessionBookmark(session, session.reference.agentName)
      }
    />
  );
}

function InvalidRouteContent() {
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-6"
    >
      <h3 className="console-mono mb-2 text-sm font-semibold text-[var(--console-text)]">
        Page not found
      </h3>
      <p className="console-mono mb-3 text-xs text-[var(--console-text-secondary)]">
        This address does not match any dashboard, agent, or session route.
      </p>
      <Link
        to="/"
        className="console-mono text-xs text-[var(--console-accent)] underline underline-offset-2"
      >
        Back to dashboard
      </Link>
    </div>
  );
}

function RouteContent({ route }: { route: AppRouteModel }) {
  switch (route.mode) {
    case "root":
      return <RootRouteContent route={route} />;
    case "projects":
      return <ProjectsRouteContent route={route} />;
    case "project":
      return <ProjectRouteContent route={route} />;
    case "agent":
      return <AgentRouteContent route={route} />;
    case "session":
      return <SessionRouteContent route={route} />;
    case "missingAgent":
      return <MissingAgentRouteContent route={route} />;
    case "invalidRoute":
      return <InvalidRouteContent />;
  }
}

export function AppRouteContent({ load, search, route }: AppRouteContentProps) {
  if (load.loading) return <SessionDetailSkeleton />;
  if (search.active) return <SearchRouteContent search={search} />;
  if (load.error) return <LoadError load={load} />;
  return <RouteContent route={route} />;
}
