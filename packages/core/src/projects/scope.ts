import { resolve, sep } from "node:path";
import type { ProjectIdentityRef, SessionHead } from "../types/index.js";
import { computeIdentity, matchesProjectIdentity, type IdentityFs } from "./identity.js";
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
  return {
    identity: { kind: identity.kind, key: identity.key },
    path: normalizeScopePath(queryPath),
  };
}

export function matchesProjectScope(session: SessionHead, scope: ProjectScopeMatcher): boolean {
  if (!session.directory) return false;
  if (matchesProjectIdentity(session.project_identity, scope.identity)) return true;
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
