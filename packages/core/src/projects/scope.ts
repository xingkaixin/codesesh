import { resolve, sep } from "node:path";
import type { SessionHead } from "../types/index.js";
import { computeIdentity, type IdentityFs } from "./identity.js";
import { realFs } from "./fs.js";

export interface ProjectScopeMatcher {
  identityKey: string;
  path: string;
}

export function createProjectScopeMatcher(
  queryPath: string,
  fs: IdentityFs = realFs,
): ProjectScopeMatcher {
  return {
    identityKey: computeIdentity(queryPath, fs).key,
    path: normalizeScopePath(queryPath),
  };
}

export function matchesProjectScope(session: SessionHead, scope: ProjectScopeMatcher): boolean {
  if (!session.directory) return false;
  if (session.project_identity?.key === scope.identityKey) return true;
  return isPathScopeMatch(scope.path, session.directory);
}

export function filterSessionsByProjectScope(
  sessions: SessionHead[],
  queryPath: string,
  fs?: IdentityFs,
): SessionHead[] {
  const scope = createProjectScopeMatcher(queryPath, fs);
  return sessions.filter((session) => matchesProjectScope(session, scope));
}

function isPathScopeMatch(queryPath: string, sessionPath: string): boolean {
  const session = normalizeScopePath(sessionPath);
  return (
    session === queryPath ||
    session.startsWith(queryPath + "/") ||
    queryPath.startsWith(session + "/")
  );
}

function normalizeScopePath(path: string): string {
  return resolve(path).replaceAll(sep, "/");
}
