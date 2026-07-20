import { APP_ROUTE_IDS } from "./app-routes";
import type { ProjectIdentityKind } from "./api";
import { isProjectIdentityKind } from "./projects";

export type ViewState =
  | { mode: "root"; activeAgentKey: null; activeSessionSlug: null }
  | { mode: "projects"; activeAgentKey: null; activeSessionSlug: null }
  | {
      mode: "project";
      activeAgentKey: null;
      activeSessionSlug: null;
      activeProjectKind: ProjectIdentityKind;
      activeProjectKey: string;
    }
  | { mode: "agent"; activeAgentKey: string; activeSessionSlug: null }
  | { mode: "session"; activeAgentKey: string; activeSessionSlug: string }
  | { mode: "missingAgent"; activeAgentKey: null; activeSessionSlug: null; attemptedKey: string }
  | {
      mode: "missingSession";
      activeAgentKey: string;
      activeSessionSlug: string;
      attemptedSessionSlug: string;
    }
  | { mode: "invalidRoute"; activeAgentKey: null; activeSessionSlug: null };

export interface ViewRouteMatch {
  id: string;
  params: Readonly<Record<string, string | undefined>>;
}

const invalidRoute: ViewState = {
  mode: "invalidRoute",
  activeAgentKey: null,
  activeSessionSlug: null,
};

export function viewStateFromRouteMatches(
  matches: readonly ViewRouteMatch[],
  validAgentKeys: ReadonlySet<string>,
): ViewState {
  const match = matches.at(-1);
  if (!match) return invalidRoute;

  if (match.id === APP_ROUTE_IDS.root) {
    return { mode: "root", activeAgentKey: null, activeSessionSlug: null };
  }
  if (match.id === APP_ROUTE_IDS.projects) {
    return { mode: "projects", activeAgentKey: null, activeSessionSlug: null };
  }
  if (match.id === APP_ROUTE_IDS.project) {
    const kind = match.params.projectKind;
    const key = match.params.projectKey;
    if (!kind || !key || !isProjectIdentityKind(kind)) return invalidRoute;
    return {
      mode: "project",
      activeAgentKey: null,
      activeSessionSlug: null,
      activeProjectKind: kind,
      activeProjectKey: key,
    };
  }
  if (match.id === APP_ROUTE_IDS.agent || match.id === APP_ROUTE_IDS.session) {
    const agentKey = match.params.agentKey?.toLowerCase();
    if (!agentKey || !validAgentKeys.has(agentKey)) {
      return {
        mode: "missingAgent",
        activeAgentKey: null,
        activeSessionSlug: null,
        attemptedKey: agentKey ?? "",
      };
    }
    if (match.id === APP_ROUTE_IDS.agent) {
      return { mode: "agent", activeAgentKey: agentKey, activeSessionSlug: null };
    }
    const sessionSlug = match.params.sessionSlug;
    if (!sessionSlug) return invalidRoute;
    return { mode: "session", activeAgentKey: agentKey, activeSessionSlug: sessionSlug };
  }
  return invalidRoute;
}
