export function getProjectPath(projectKey: string): string {
  return `/projects/${encodeURIComponent(projectKey)}`;
}
