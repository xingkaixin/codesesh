import {
  getProjectIdentityKey,
  isProjectIdentityKind,
  type ProjectIdentityRef,
} from "@codesesh/core/contract";
import type { ApiProjectGroup } from "./api";

// Identity semantics come from the contract; this module only turns them into
// URLs and back. A route key is percent-encoded, an identity key is not.
export { getProjectIdentityKey, isProjectIdentityKind };
export type ProjectRouteIdentity = ProjectIdentityRef;

export function getProjectGroupIdentity(project: ApiProjectGroup): ProjectRouteIdentity {
  return { kind: project.identityKind, key: project.identityKey };
}

export function getProjectPath(project: ProjectRouteIdentity): string {
  return `/projects/${encodeURIComponent(project.kind)}/${encodeURIComponent(project.key)}`;
}
