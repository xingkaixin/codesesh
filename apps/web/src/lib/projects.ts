import {
  getProjectIdentityKey,
  isProjectIdentityKind,
  type ProjectIdentityRef,
  type ApiProjectGroup,
} from "@codesesh/contract";

// Identity semantics come from the contract; this module only turns them into
// URLs and back. A route key is percent-encoded, an identity key is not.
export { getProjectIdentityKey, isProjectIdentityKind };

export type ProjectRouteIdentity = ProjectIdentityRef;

export function getProjectGroupIdentity(project: ApiProjectGroup): ProjectRouteIdentity {
  return { kind: project.identityKind, key: project.identityKey };
}

export function isGitRemoteFallbackDisplayName(identity: {
  kind: string;
  key: string;
  displayName?: string;
}): boolean {
  if (identity.kind !== "git_remote" || !identity.displayName) return false;
  const tail = identity.key.split("/").findLast(Boolean) ?? identity.key;
  return identity.displayName === tail;
}

export function buildProjectDisplayNameMap(
  projects: readonly Pick<ApiProjectGroup, "identityKind" | "identityKey" | "displayName">[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const project of projects) {
    if (!project.displayName) continue;
    names.set(
      getProjectIdentityKey({ kind: project.identityKind, key: project.identityKey }),
      project.displayName,
    );
  }
  return names;
}

export function resolveProjectDisplayName(
  identity:
    | {
        kind: ProjectIdentityRef["kind"];
        key: string;
        displayName?: string;
      }
    | null
    | undefined,
  projectDisplayNames?: ReadonlyMap<string, string>,
): string | undefined {
  if (!identity) return undefined;
  return (
    projectDisplayNames?.get(getProjectIdentityKey({ kind: identity.kind, key: identity.key })) ||
    identity.displayName ||
    undefined
  );
}

export function getProjectPath(project: ProjectRouteIdentity): string {
  return `/projects/${encodeURIComponent(project.kind)}/${encodeURIComponent(project.key)}`;
}
