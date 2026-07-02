import type { ProjectGroup, ProjectIdentityKind } from "./api";

export interface ProjectRouteIdentity {
  kind: ProjectIdentityKind;
  key: string;
}

export function getProjectGroupIdentity(project: ProjectGroup): ProjectRouteIdentity {
  return { kind: project.identityKind, key: project.identityKey };
}

const projectIdentityKinds = new Set<string>([
  "git_remote",
  "git_common_dir",
  "manifest_path",
  "synthetic",
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
  return `/projects/${encodeURIComponent(project.kind)}/${encodeURIComponent(project.key)}`;
}
