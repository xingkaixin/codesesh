import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import {
  lazy,
  Suspense,
  useCallback,
  useId,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import { Link, useLocation } from "react-router-dom";
import type { SessionDetailError, SessionMessagePaging } from "../../hooks/useSessionDetail";
import type { AgentCatalog } from "../../lib/agents";
import type {
  AgentInfo,
  AppConfig,
  ApiProjectGroup,
  ApiProjectPage,
  SessionDetail,
  SessionHead,
} from "@codesesh/contract";
import { getSessionRouteKey, type IndexedSession } from "../../lib/session-indexes";
import type { TimeWindowPreset } from "../../lib/time-window";
import type { ViewState } from "../../lib/view-state";
import type { LandingAgentItem } from "../DetailLanding";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";
import type { SearchFilterState, SearchLoadState, SearchProjectOption } from "./types";
import { SearchControls, type SearchControlsHandle } from "./SearchControls";
import { BUTTON_PRIMARY_CLASS } from "../ui/dialog-styles";
import { EmptyState } from "../ui/empty-state";
import { Funnel, RefreshCw, XCircle } from "../ui/icons";

const DetailLanding = lazy(() =>
  import("../DetailLanding").then((module) => ({ default: module.DetailLanding })),
);
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
  import("../SessionDetail").then((module) => ({ default: module.SessionDetailRoute })),
);
const SearchResultsPanel = lazy(() =>
  import("./SearchResultsPanel").then((module) => ({ default: module.SearchResultsPanel })),
);

function LazySurface({ children }: { children: ReactNode }) {
  useLocale();

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
  messagePaging?: SessionMessagePaging;
  session: SessionDetail | null;
  loading: boolean;
  error: SessionDetailError | null;
  retry: () => void;
}

interface OverviewModel {
  window: AppConfig["window"] | null;
  rangePreset: TimeWindowPreset;
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
  controls: Ref<SearchControlsHandle>;
  onSubmit: (query: string) => void;
}

interface BookmarkContentModel {
  isBookmarked: (agentKey: string, sessionId: string, sourceNodeId?: string) => boolean;
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

function SearchRouteContent({
  search,
  controlsRef,
}: {
  search: SearchContentModel;
  controlsRef: Ref<SearchControlsHandle>;
}) {
  useLocale();

  const filtersId = useId();
  const activeFilters = Object.values(search.filters).filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(activeFilters > 0);
  const resultCount = search.state.status === "loaded" ? search.state.results.length : 0;
  return (
    <RenderProfiler
      id="SearchResultsPanel"
      detail={{ results: resultCount, loading: search.state.status === "loading" }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchControls
          ref={controlsRef}
          onSubmit={search.onSubmit}
          initialQuery={search.query}
          autoFocus
        />
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls={filtersOpen ? filtersId : undefined}
          onClick={() => setFiltersOpen((open) => !open)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 text-xs font-medium text-[var(--console-text)] shadow-[var(--shadow-raised)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <Funnel aria-hidden="true" className="size-3.5 text-[var(--console-muted)]" />
          {t("Filters")}
          {activeFilters > 0 ? (
            <span className="console-mono inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--brand-soft)] px-1 text-[10px] text-[var(--brand)]">
              {activeFilters}
            </span>
          ) : null}
        </button>
      </div>
      <LazySurface>
        <SearchResultsPanel
          query={search.query}
          state={search.state}
          filtersOpen={filtersOpen}
          filtersId={filtersId}
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
  useLocale();

  return (
    <EmptyState
      role="alert"
      tone="error"
      icon={<XCircle className="size-4" />}
      title={load.error}
      className="mx-auto max-w-4xl"
    >
      <button type="button" onClick={load.retry} className={`${BUTTON_PRIMARY_CLASS} mt-1.5`}>
        <RefreshCw aria-hidden="true" className="size-3.5" />
        {t("Retry")}
      </button>
    </EmptyState>
  );
}

function RootRouteContent({ route }: { route: RootRouteModel }) {
  useLocale();

  return (
    <RenderProfiler id="OverviewScreen" detail={{ projects: route.projectCount }}>
      <LazySurface>
        <OverviewScreen
          window={route.overview.window}
          agentCatalog={route.agentCatalog}
          rangePreset={route.overview.rangePreset}
        />
      </LazySurface>
    </RenderProfiler>
  );
}

function ProjectsRouteContent({ route }: { route: ProjectsRouteModel }) {
  useLocale();

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
  useLocale();

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
      />
    </LazySurface>
  );
}

function AgentRouteContent({ route }: { route: AgentRouteModel }) {
  useLocale();

  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  const toggleSessionBookmark = route.bookmarks.toggleSessionBookmark;
  const toggleBookmark = useCallback(
    (session: IndexedSession) => toggleSessionBookmark(session, session.reference.agentName),
    [toggleSessionBookmark],
  );
  return (
    <LazySurface>
      <DetailLanding
        type="agent"
        agentCatalog={route.agentCatalog}
        sessions={route.sessions}
        agentItems={agentItems}
        activeAgentKey={route.activeAgentKey}
        isBookmarked={route.bookmarks.isBookmarked}
        onToggleBookmark={toggleBookmark}
      />
    </LazySurface>
  );
}

function SessionRouteContent({ route }: { route: SessionRouteModel }) {
  const locale = useLocale();

  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  const currentSession = route.detail.session;
  const currentSessionAgentName = currentSession?.reference.agentName;
  const currentSessionId = currentSession?.reference.sessionId;
  const childSessions = useMemo(
    () => {
      if (!currentSessionAgentName || !currentSessionId) return [];
      return (
        route.childSessionsByParentRouteKey.get(
          getSessionRouteKey(
            currentSessionAgentName,
            currentSessionId,
            currentSession?.reference.sourceNodeId,
          ),
        ) ?? []
      );
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, route.childSessionsByParentRouteKey, currentSessionAgentName, currentSessionId],
  );
  const toggleSessionBookmark = route.bookmarks.toggleSessionBookmark;
  const toggleBookmark = useCallback(
    (session: IndexedSession) => toggleSessionBookmark(session, session.reference.agentName),
    [toggleSessionBookmark],
  );

  if (route.detail.loading) return <SessionDetailSkeleton />;
  if (route.detail.error?.kind === "missing") {
    return (
      <LazySurface>
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
      </LazySurface>
    );
  }
  if (route.detail.error?.kind === "load-failed") {
    return (
      <LazySurface>
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
      </LazySurface>
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
          key={getSessionRouteKey(
            currentSession.reference.agentName,
            currentSession.reference.sessionId,
            currentSession.reference.sourceNodeId,
          )}
          session={currentSession}
          messagePaging={route.detail.messagePaging}
          agentCatalog={route.agentCatalog}
          highlightQuery={route.detailHighlightQuery}
          childSessions={childSessions}
        />
      </LazySurface>
    </RenderProfiler>
  );
}

function MissingAgentRouteContent({ route }: { route: MissingAgentRouteModel }) {
  useLocale();

  const agentItems = useMemo(() => landingAgentItems(route.agents), [route.agents]);
  return (
    <LazySurface>
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
    </LazySurface>
  );
}

function InvalidRouteContent() {
  useLocale();

  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-6"
    >
      <h3 className="console-mono mb-2 text-sm font-semibold text-[var(--console-text)]">
        {t("Page not found")}
      </h3>
      <p className="console-mono mb-3 text-xs text-[var(--console-text-secondary)]">
        {t("This address does not match any dashboard, agent, or session route.")}
      </p>
      <Link
        to="/"
        className="console-mono text-xs text-[var(--console-accent)] underline underline-offset-2"
      >
        {t("Back to dashboard")}
      </Link>
    </div>
  );
}

function RouteContent({ route }: { route: AppRouteModel }) {
  useLocale();

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
  useLocale();

  if (load.loading) return <SessionDetailSkeleton />;
  if (search.active) return <SearchRouteContent search={search} controlsRef={search.controls} />;
  if (load.error) return <LoadError load={load} />;
  return <RouteContent route={route} />;
}
