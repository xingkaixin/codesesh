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
  getAgentFullSyncCursor,
  getAgentLastFullSyncAt,
  getCachePath,
  isAgentCacheInitialized,
  listCachedProjectGroups,
  listFileActivity,
  listModelCostDistribution,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
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
export {
  filterSessionTreeByActivityWindow,
  isChildSession,
  getRootSessions,
} from "./contract/index.js";
export type {
  FileActivityResult,
  LiveSnapshot,
  ScanOptions,
  SearchIndexSyncOptions,
  SearchIndexSyncResult,
  SearchOptions,
  SessionHeadChange,
  SessionTagTiming,
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
  ensurePrivateDirectory,
  getSmartTagSourceTimestamp,
  perf,
  restrictExistingPrivateFiles,
  restrictPrivateFile,
  setCoreDiagnostics,
} from "./utils/index.js";
export {
  getPricingGeneration,
  hasPendingPricing,
  publishPendingPricing,
  refreshPricingCache,
  type PricingGeneration,
} from "./pricing/index.js";
export { buildDashboard, getSessionActivityTime } from "./analytics/dashboard.js";
export type { DashboardData, DashboardScope } from "./analytics/dashboard.js";
export { attachProjectMetrics } from "./analytics/projects.js";
export { executeSessionSearch, filterSessionSearchCandidates } from "./search/index.js";
