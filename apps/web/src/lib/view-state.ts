import { APP_ROUTE_IDS } from "./app-routes";
import type { ProjectIdentityKind } from "./api";
import { isProjectIdentityKind } from "./projects";

export type ViewState =
  | { mode: "root"; activeAgentKey: null; activeSessionId: null }
  | { mode: "projects"; activeAgentKey: null; activeSessionId: null }
  | {
      mode: "project";
      activeAgentKey: null;
      activeSessionId: null;
      activeProjectKind: ProjectIdentityKind;
      activeProjectKey: string;
    }
  | { mode: "agent"; activeAgentKey: string; activeSessionId: null }
  | { mode: "session"; activeAgentKey: string; activeSessionId: string }
  | { mode: "missingAgent"; activeAgentKey: null; activeSessionId: null; attemptedKey: string }
  // An unknown session id keeps mode "session"; the 404 is resolved later by
  // useSessionDetail and rendered by the session surface itself.
  | { mode: "invalidRoute"; activeAgentKey: null; activeSessionId: null };

export interface ViewRouteMatch {
  id: string;
  params: Readonly<Record<string, string | undefined>>;
}

const invalidRoute: ViewState = {
  mode: "invalidRoute",
  activeAgentKey: null,
  activeSessionId: null,
};

export function viewStateFromRouteMatches(
  matches: readonly ViewRouteMatch[],
  validAgentKeys: ReadonlySet<string>,
): ViewState {
  const match = matches.at(-1);
  if (!match) return invalidRoute;

  if (match.id === APP_ROUTE_IDS.root) {
    return { mode: "root", activeAgentKey: null, activeSessionId: null };
  }
  if (match.id === APP_ROUTE_IDS.projects) {
    return { mode: "projects", activeAgentKey: null, activeSessionId: null };
  }
  if (match.id === APP_ROUTE_IDS.project) {
    const kind = match.params.projectKind;
    const key = match.params.projectKey;
    if (!kind || !key || !isProjectIdentityKind(kind)) return invalidRoute;
    return {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
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
        activeSessionId: null,
        attemptedKey: agentKey ?? "",
      };
    }
    if (match.id === APP_ROUTE_IDS.agent) {
      return { mode: "agent", activeAgentKey: agentKey, activeSessionId: null };
    }
    const sessionId = match.params.sessionId;
    if (!sessionId) return invalidRoute;
    return { mode: "session", activeAgentKey: agentKey, activeSessionId: sessionId };
  }
  return invalidRoute;
}
