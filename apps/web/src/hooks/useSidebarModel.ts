import { useMemo } from "react";
import type { AgentInfo, ApiProjectGroup, SessionDetail, SessionHead } from "../lib/api";
import {
  getProjectGroupIdentity,
  getProjectIdentityKey,
  type ProjectRouteIdentity,
} from "../lib/projects";
import {
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionReferenceKey,
  getSessionRouteKey,
  type SessionIndexes,
} from "../lib/session-indexes";
import type { ViewState } from "../lib/view-state";

interface UseSidebarModelOptions {
  viewState: ViewState;
  sessionIndexes: SessionIndexes;
  session: SessionDetail | null;
  agents: AgentInfo[];
  projects: ApiProjectGroup[];
  selectedProjectAgent?: string;
  isSessionBookmarked: (agentKey: string, sessionId: string) => boolean;
}

export interface ProjectNavigationModel {
  identity: ProjectRouteIdentity;
  identityKey: string;
  project: ApiProjectGroup | null;
}

function findProject(
  projects: ApiProjectGroup[],
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
            getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionId),
          ) ?? null)
        : null;
    const openedSessionData =
      viewState.mode === "session" &&
      session?.reference.agentName === viewState.activeAgentKey &&
      session.reference.sessionId === viewState.activeSessionId
        ? session
        : null;
    const openedSessionProjectIdentity =
      openedSessionData?.project_identity ?? openedSessionHead?.project_identity ?? null;
    const selectedProjectIdentity =
      viewState.mode === "project"
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

    const sidebarSessions = getProjectSessions(
      sessionIndexes,
      selectedProjectIdentityKey,
      selectedProjectAgent,
    );
    const sidebarSessionLookup = buildSidebarSessionLookup(sidebarSessions);
    return {
      activeAgentKey,
      activeAgent,
      activeProject,
      activeProjectSessions,
      openedSessionProjectIdentity,
      selectedProjectNavigation,
      sidebarSessions,
      sidebarSessionLookup,
    };
  }, [agents, projects, selectedProjectAgent, session, sessionIndexes, viewState]);

  const bookmarkedSidebarSessionReferences = useMemo(
    () =>
      new Set(
        model.sidebarSessions
          .filter((sessionItem) =>
            isSessionBookmarked(sessionItem.reference.agentName, sessionItem.reference.sessionId),
          )
          .map(getSessionReferenceKey),
      ),
    [isSessionBookmarked, model.sidebarSessions],
  );

  return { ...model, bookmarkedSidebarSessionReferences };
}
