import type { SessionHead } from "../types/index.js";
import { matchesProjectScope, type ProjectScopeMatcher } from "../projects/scope.js";

export interface SessionQueryScope {
  agents?: readonly string[];
  projectScope?: ProjectScopeMatcher;
}

export function matchesSessionQueryScope(session: SessionHead, scope?: SessionQueryScope): boolean {
  if (scope?.agents?.length && !scope.agents.includes(session.reference.agentName)) return false;
  return !scope?.projectScope || matchesProjectScope(session, scope.projectScope);
}
