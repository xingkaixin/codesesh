import { useMemo } from "react";
import { Dashboard } from "../Dashboard";
import { DetailLanding, type LandingAgentItem } from "../DetailLanding";
import { ProjectDashboardView, ProjectsOverview } from "../Projects";
import { RenderProfiler } from "../RenderProfiler";
import { SessionDetail } from "../SessionDetail";
import { SessionDetailSkeleton } from "../SessionDetailSkeleton";
import type { useBookmarks } from "../../hooks/useBookmarks";
import type { useDashboard } from "../../hooks/useDashboard";
import type { useSessionDetail } from "../../hooks/useSessionDetail";
import type { useSessionSearch } from "../../hooks/useSessionSearch";
import type { AgentInfo, ProjectGroup } from "../../lib/api";
import { getProjectGroupIdentity, getProjectIdentityKey } from "../../lib/projects";
import type { SessionIndexes } from "../../lib/session-indexes";
import type { ViewState } from "../../lib/view-state";
import type { SearchProjectOption } from "./types";
import { SearchResultsPanel } from "./SearchResultsPanel";

interface AppRouteContentProps {
  loading: boolean;
  error: string | null;
  viewState: ViewState;
  detailHighlightQuery: string;
  agents: AgentInfo[];
  agentNameMap: Map<string, string>;
  projects: ProjectGroup[];
  sessionIndexes: SessionIndexes;
  dashboard: ReturnType<typeof useDashboard>["dashboard"];
  sessionDetail: ReturnType<typeof useSessionDetail>;
  projectController: ReturnType<typeof useDashboard>;
  search: ReturnType<typeof useSessionSearch>;
  bookmarks: ReturnType<typeof useBookmarks>;
}

export function AppRouteContent({
  loading,
  error,
  viewState,
  detailHighlightQuery,
  agents,
  agentNameMap,
  projects,
  sessionIndexes,
  dashboard,
  sessionDetail,
  projectController,
  search,
  bookmarks,
}: AppRouteContentProps) {
  const landingAgentItems = useMemo<LandingAgentItem[]>(
    () =>
      agents
        .filter((agent) => agent.count > 0)
        .map((agent) => ({
          key: agent.name.toLowerCase(),
          name: agent.displayName,
          icon: agent.icon,
          count: agent.count,
        })),
    [agents],
  );
  const activeProjectIdentityKey =
    viewState.mode === "project"
      ? getProjectIdentityKey({
          kind: viewState.activeProjectKind,
          key: viewState.activeProjectKey,
        })
      : null;
  const activeProject = useMemo(
    () =>
      projects.find(
        (project) =>
          activeProjectIdentityKey === getProjectIdentityKey(getProjectGroupIdentity(project)),
      ) ?? null,
    [activeProjectIdentityKey, projects],
  );
  const activeProjectSessions = activeProjectIdentityKey
    ? (sessionIndexes.byLandingProjectIdentityKey.get(activeProjectIdentityKey) ?? [])
    : [];
  const searchProjectOptions = buildSearchProjectOptions(search, sessionIndexes.projectOptions);

  if (loading) return <SessionDetailSkeleton />;
  if (search.searchMode) {
    return (
      <RenderProfiler
        id="SearchResultsPanel"
        detail={{ results: search.searchResults.length, loading: search.searchLoading }}
      >
        <SearchResultsPanel
          query={search.activeSearchQuery}
          state={search.searchState}
          agentNameMap={agentNameMap}
          agents={agents}
          projects={searchProjectOptions}
          filters={search.searchFilters}
          onChangeFilters={search.setSearchFilters}
          onOpenResult={search.closeSearch}
          onRetry={search.retrySearch}
          selectedIndex={search.selectedSearchIndex}
          registerResultRef={(key, node) => {
            if (node) search.searchResultRefs.current.set(key, node);
            else search.searchResultRefs.current.delete(key);
          }}
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
          projects={projects}
          bookmarkedSessions={bookmarks.bookmarkedSessions}
          isBookmarked={bookmarks.isSessionBookmarked}
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
        sessions={sessionIndexes.landingSessions}
        agentItems={landingAgentItems}
        isBookmarked={bookmarks.isSessionBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  if (viewState.mode === "projects") return <ProjectsOverview projects={projects} />;
  if (viewState.mode === "project") {
    return (
      <ProjectDashboardView
        project={activeProject}
        projectKey={viewState.activeProjectKey}
        dashboard={projectController.dashboard}
        loading={projectController.loading}
        error={projectController.error}
        sessions={activeProjectSessions}
        activeAgent={projectController.selectedAgent}
        onChangeAgent={projectController.setSelectedAgent}
        isBookmarked={bookmarks.isSessionBookmarked}
        onToggleSessionBookmark={bookmarks.toggleSessionBookmark}
      />
    );
  }
  if (viewState.mode === "agent") {
    return (
      <DetailLanding
        type="agent"
        sessions={sessionIndexes.byLandingAgent.get(viewState.activeAgentKey) ?? []}
        agentItems={landingAgentItems}
        activeAgentKey={viewState.activeAgentKey}
        isBookmarked={bookmarks.isSessionBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  if (viewState.mode === "session") {
    if (sessionDetail.sessionLoading) return <SessionDetailSkeleton />;
    if (sessionDetail.sessionError || !sessionDetail.session) {
      return (
        <DetailLanding
          type="missing-session"
          sessions={sessionIndexes.byLandingAgent.get(viewState.activeAgentKey) ?? []}
          agentItems={landingAgentItems}
          activeAgentKey={viewState.activeAgentKey}
          attemptedSessionSlug={viewState.activeSessionSlug}
          isBookmarked={bookmarks.isSessionBookmarked}
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
        <SessionDetail session={sessionDetail.session} highlightQuery={detailHighlightQuery} />
      </RenderProfiler>
    );
  }
  if (viewState.mode === "missingAgent") {
    return (
      <DetailLanding
        type="missing-agent"
        sessions={sessionIndexes.landingSessions}
        agentItems={landingAgentItems}
        attemptedAgentKey={viewState.attemptedKey}
        isBookmarked={bookmarks.isSessionBookmarked}
        onToggleBookmark={(session) => bookmarks.toggleSessionBookmark(session, session.agentKey)}
      />
    );
  }
  return <div className="text-sm text-[var(--console-muted)]">Invalid route.</div>;
}

function buildSearchProjectOptions(
  search: ReturnType<typeof useSessionSearch>,
  projectOptions: SearchProjectOption[],
): SearchProjectOption[] {
  if (!search.usesServerSearch) return projectOptions;

  const byKey = new Map<string, SearchProjectOption>();
  const sourceResults = search.searchLoading ? [] : search.searchResults;
  for (const result of sourceResults) {
    const identity = result.session.project_identity;
    if (!identity?.key) continue;
    const key = getProjectIdentityKey(identity);
    const current = byKey.get(key);
    if (current) {
      current.count += 1;
    } else {
      byKey.set(key, {
        key,
        identityKind: identity.kind,
        identityKey: identity.key,
        label: identity.displayName || result.session.directory,
        count: 1,
        showCount: false,
      });
    }
  }

  const selectedKey = search.searchFilters.project
    ? getProjectIdentityKey(search.searchFilters.project)
    : undefined;
  const selected = selectedKey
    ? projectOptions.find((project) => project.key === selectedKey)
    : undefined;
  if (selectedKey && selected && !byKey.has(selectedKey)) {
    byKey.set(selected.key, { ...selected, count: 0, showCount: false });
  }
  return [...byKey.values()].toSorted((a, b) => b.count - a.count).slice(0, 8);
}
