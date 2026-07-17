import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, ProjectGroup, SessionData, SessionHead } from "../lib/api";
import {
  getProjectGroupIdentity,
  getProjectIdentityKey,
  type ProjectRouteIdentity,
} from "../lib/projects";
import {
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionAgentKey,
  getSessionRouteKey,
  type SessionIndexes,
} from "../lib/session-indexes";
import type { ViewState } from "../lib/view-state";
import type { BrowseBy } from "../components/app/types";

interface UseSidebarModelOptions {
  viewState: ViewState;
  sessionIndexes: SessionIndexes;
  session: SessionData | null;
  agents: AgentInfo[];
  projects: ProjectGroup[];
  selectedProjectAgent?: string;
  isSessionBookmarked: (agentKey: string, sessionId: string) => boolean;
}

export interface ProjectNavigationModel {
  identity: ProjectRouteIdentity;
  identityKey: string;
  project: ProjectGroup | null;
}

function browseByForRoute(viewState: ViewState): BrowseBy | null {
  if (viewState.mode === "projects" || viewState.mode === "project") return "projects";
  if (viewState.mode === "agent" || viewState.mode === "missingAgent") return "agents";
  return null;
}

function findProject(
  projects: ProjectGroup[],
  identityKey: string,
): ProjectNavigationModel["project"] {
  return (
    projects.find(
      (project) => identityKey === getProjectIdentityKey(getProjectGroupIdentity(project)),
    ) ?? null
  );
}

function getProjectSessions(
  sessionIndexes: SessionIndexes,
  projectIdentityKey: string | null,
  agentKey?: string,
): SessionHead[] {
  if (!projectIdentityKey) return [];
  if (!agentKey) {
    return sessionIndexes.byProjectIdentityKey.get(projectIdentityKey) ?? [];
  }
  return (
    sessionIndexes.byProjectAgentKey.get(getProjectAgentKey(projectIdentityKey, agentKey)) ?? []
  );
}

export function useSidebarModel({
  viewState,
  sessionIndexes,
  session,
  agents,
  projects,
  selectedProjectAgent,
  isSessionBookmarked,
}: UseSidebarModelOptions) {
  const routeBrowseBy = browseByForRoute(viewState);
  const [rememberedBrowseBy, setRememberedBrowseBy] = useState<BrowseBy>(routeBrowseBy ?? "agents");
  const browseBy = routeBrowseBy ?? rememberedBrowseBy;

  useEffect(() => {
    if (routeBrowseBy) setRememberedBrowseBy(routeBrowseBy);
  }, [routeBrowseBy]);

  const selectBrowseBy = useCallback((next: BrowseBy) => {
    setRememberedBrowseBy(next);
  }, []);

  const model = useMemo(() => {
    const activeAgentKey = viewState.activeAgentKey;
    const activeAgent = agents.find((agent) => agent.name.toLowerCase() === activeAgentKey) ?? null;
    const activeProjectIdentity: ProjectRouteIdentity | null =
      viewState.mode === "project"
        ? { kind: viewState.activeProjectKind, key: viewState.activeProjectKey }
        : null;
    const activeProjectIdentityKey = activeProjectIdentity
      ? getProjectIdentityKey(activeProjectIdentity)
      : null;
    const activeProject =
      activeProjectIdentity && activeProjectIdentityKey
        ? {
            identity: activeProjectIdentity,
            identityKey: activeProjectIdentityKey,
            project: findProject(projects, activeProjectIdentityKey),
          }
        : null;
    const activeProjectSessions = activeProjectIdentityKey
      ? (sessionIndexes.byLandingProjectIdentityKey.get(activeProjectIdentityKey) ?? [])
      : [];

    const openedSessionHead =
      viewState.mode === "session"
        ? (sessionIndexes.byRouteKey.get(
            getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionSlug),
          ) ?? null)
        : null;
    const openedSessionData =
      viewState.mode === "session" && session?.id === viewState.activeSessionSlug ? session : null;
    const openedSessionProjectIdentity =
      openedSessionData?.project_identity ?? openedSessionHead?.project_identity ?? null;
    const selectedProjectIdentity =
      browseBy !== "projects"
        ? null
        : viewState.mode === "project"
          ? activeProjectIdentity
          : viewState.mode === "session"
            ? openedSessionProjectIdentity
            : null;
    const selectedProjectIdentityKey = selectedProjectIdentity
      ? getProjectIdentityKey(selectedProjectIdentity)
      : null;
    let selectedProjectNavigation: ProjectNavigationModel | null = null;
    if (selectedProjectIdentity && selectedProjectIdentityKey) {
      selectedProjectNavigation =
        activeProject?.identityKey === selectedProjectIdentityKey
          ? activeProject
          : {
              identity: selectedProjectIdentity,
              identityKey: selectedProjectIdentityKey,
              project: findProject(projects, selectedProjectIdentityKey),
            };
    }

    const agentSessions = activeAgentKey ? (sessionIndexes.byAgent.get(activeAgentKey) ?? []) : [];
    const projectSessions = getProjectSessions(
      sessionIndexes,
      selectedProjectIdentityKey,
      selectedProjectAgent,
    );
    const sidebarSessions = browseBy === "projects" ? projectSessions : agentSessions;
    const sidebarSessionLookup = buildSidebarSessionLookup(sidebarSessions);
    const bookmarkedSidebarSessionIds = new Set(
      sidebarSessions
        .filter((sessionItem) =>
          isSessionBookmarked(getSessionAgentKey(sessionItem), sessionItem.id),
        )
        .map((sessionItem) => sessionItem.id),
    );

    return {
      activeAgentKey,
      activeAgent,
      activeProject,
      activeProjectSessions,
      openedSessionProjectIdentity,
      selectedProjectNavigation,
      sidebarSessions,
      sidebarSessionLookup,
      bookmarkedSidebarSessionIds,
    };
  }, [
    agents,
    browseBy,
    isSessionBookmarked,
    projects,
    selectedProjectAgent,
    session,
    sessionIndexes,
    viewState,
  ]);

  return { browseBy, selectBrowseBy, ...model };
}
