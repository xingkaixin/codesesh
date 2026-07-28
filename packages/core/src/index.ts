// Register all agent adapters (side effect import)
import "./agents/register.js";

export type {
  FileActivityKind,
  ProjectIdentityRef,
  SessionDetail,
  SessionHead,
  SessionReference,
  SmartTag,
} from "./types/index.js";
export {
  BaseAgent,
  createRegisteredAgents,
  diffSessionSources,
  FileSystemSessionSource,
  getAgentInfoMap,
  getRegisteredAgents,
  registerAgent,
} from "./agents/index.js";
export type {
  AgentRoots,
  AgentScanOptions,
  AgentScanProgress,
  ChangeCheckResult,
  SessionCacheMeta,
  SessionSourceRef,
  SessionWatchPlan,
} from "./agents/index.js";
export {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  clearCache,
  computeSessionDiff,
  ensureSessionTagsSync,
  getAgentLastFullSyncAt,
  getCachePath,
  isAgentCacheInitialized,
  listCachedProjectGroups,
  listFileActivity,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncCompleted,
  materializeSessionDetailResponse,
  mergeSearchQueryOptions,
  mergeSortedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
  scanSessions,
  sessionSignature,
  sortSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./discovery/index.js";
export type {
  FileActivityResult,
  LiveSnapshot,
  ScanOptions,
  SearchIndexSyncOptions,
  SearchIndexSyncResult,
  SearchOptions,
  SessionHeadChange,
} from "./discovery/index.js";
export {
  createProjectScopeMatcher,
  isProjectIdentityKind,
  matchesProjectIdentity,
  matchesProjectScope,
} from "./projects/index.js";
export {
  BookmarkStorageUnavailableError,
  deleteBookmark,
  deleteSessionAlias,
  importBookmarks,
  listBookmarks,
  listSessionAliases,
  SessionAliasValidationError,
  StateStorageUnavailableError,
  upsertBookmark,
  upsertSessionAlias,
} from "./state/index.js";
export type { BookmarkRecord, SessionAlias } from "./state/index.js";
export {
  classifySessionTags,
  getSmartTagSourceTimestamp,
  perf,
  setCoreDiagnostics,
} from "./utils/index.js";
export { refreshPricingCache } from "./pricing/index.js";
export { buildDashboard, getSessionActivityTime } from "./analytics/dashboard.js";
export type { DashboardData, DashboardScope } from "./analytics/dashboard.js";
export { attachProjectMetrics } from "./analytics/projects.js";
export { executeSessionSearch, filterSessionSearchCandidates } from "./search/index.js";
