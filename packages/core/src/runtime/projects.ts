export type { ProjectIdentityRef } from "../types/index.js";
export {
  computeIdentityProjection,
  createProjectScopeMatcherFromIdentity,
  isProjectIdentityKind,
  matchesProjectIdentity,
  matchesProjectScope,
  normalizeProjectDirectory,
  PROJECT_IDENTITY_RESOLVER_REVISION,
} from "../projects/index.js";
export type { ProjectIdentityProjection, ProjectScopeMatcher } from "../projects/index.js";
export {
  attachProjectMetrics,
  attachProjectMetricsFromTree,
  summarizeProjects,
} from "../analytics/projects.js";
