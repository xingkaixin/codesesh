import type { ProjectIdentityKind } from "./api";

export interface ProjectRouteIdentity {
  kind: ProjectIdentityKind;
  key: string;
}

const projectIdentityKinds = new Set<string>([
  "git_remote",
  "git_common_dir",
  "manifest_path",
  "path",
  "loose",
]);

export function isProjectIdentityKind(value: string): value is ProjectIdentityKind {
  return projectIdentityKinds.has(value);
}

export function getProjectIdentityKey(project: ProjectRouteIdentity): string {
  return `${project.kind}:${project.key}`;
}

export function decodeProjectRouteKey(value: string): string {
  return decodeURIComponent(value);
}

export function getProjectPath(project: ProjectRouteIdentity): string {
  // React Router decodes path segments before App parses them, so key needs one spare encode pass.
  return `/projects/${encodeURIComponent(project.kind)}/${encodeURIComponent(encodeURIComponent(project.key))}`;
}
