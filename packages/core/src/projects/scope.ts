import type { ProjectIdentityRef, SessionHead } from "../types/index.js";
import {
  computeIdentity,
  matchesProjectIdentity,
  normalizeProjectDirectory,
  type IdentityFs,
} from "./identity.js";
import { realFs } from "./fs.js";

export interface ProjectScopeMatcher {
  identity: ProjectIdentityRef;
  path: string;
}

export function createProjectScopeMatcher(
  queryPath: string,
  fs: IdentityFs = realFs,
): ProjectScopeMatcher {
  const identity = computeIdentity(queryPath, fs);
  return createProjectScopeMatcherFromIdentity(queryPath, identity);
}

export function createProjectScopeMatcherFromIdentity(
  queryPath: string,
  identity: ProjectIdentityRef,
): ProjectScopeMatcher {
  return {
    identity: { kind: identity.kind, key: identity.key },
    path: normalizeProjectScopePath(queryPath),
  };
}

export function matchesProjectScope(session: SessionHead, scope: ProjectScopeMatcher): boolean {
  if (matchesProjectIdentity(session.project_identity, scope.identity)) return true;
  return session.directory ? isPathScopeMatch(scope.path, session.directory) : false;
}

export function filterSessionsByProjectScope<T extends SessionHead>(
  sessions: T[],
  queryPath: string,
  fs?: IdentityFs,
): T[] {
  const scope = createProjectScopeMatcher(queryPath, fs);
  return sessions.filter((session) => matchesProjectScope(session, scope));
}

function isPathScopeMatch(queryPath: string, sessionPath: string): boolean {
  const session = normalizeProjectScopePath(sessionPath);
  return (
    session === queryPath ||
    session.startsWith(queryPath + "/") ||
    queryPath.startsWith(session + "/")
  );
}

export function normalizeProjectScopePath(path: string): string {
  return normalizeProjectDirectory(path).replaceAll("\\", "/");
}
