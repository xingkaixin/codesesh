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
  createSessionSourceFailure,
  diffSessionSources,
  FileSystemSessionSource,
  getAgentInfoMap,
  getRegisteredAgents,
  registerAgent,
  reportSessionSourceOutcome,
  synchronizeSessionSources,
} from "./agents/index.js";
export type {
  AgentScanFailure,
  AgentRoots,
  AgentScanOptions,
  AgentScanProgress,
  ChangeCheckResult,
  SessionCacheMeta,
  SessionSourceFailure,
  SessionSourceAbsenceOutcome,
  SessionSourceOutcome,
  SessionSourceScanBatch,
  SessionSourceRef,
  SessionSourceSynchronizationAdapter,
  SessionSourceSynchronizationBaseline,
  SessionSourceSynchronizationOutcome,
  SessionSourceSynchronizationRequest,
  SessionWatchPlan,
} from "./agents/index.js";
export {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  clearCache,
  commitDurableSessionPublication,
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
  loadCachedSessionHeads,
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
  sessionDetailVersion,
  sessionSignature,
  sortSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./discovery/index.js";
export { PRICING_CAPTURE_EPOCH } from "./pricing/index.js";
export {
  filterSessionTreeByActivityWindow,
  isChildSession,
  getRootSessions,
} from "./contract/index.js";
export type {
  FileActivityResult,
  LiveSnapshot,
  SaveCachedSessionsOptions,
  ScanOptions,
  SessionSnapshotCompleteness,
  DurableSessionPublication,
  DurableSessionPublicationCommitResult,
  DurableSessionPublicationFailureStage,
  SearchIndexSyncOptions,
  SearchIndexSyncFailure,
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
export type {
  AvailableBookmarkView,
  BookmarkView,
  UnavailableBookmarkView,
} from "./contract/index.js";
export {
  compareBookmarkViews,
  materializeBookmarkViews,
  type BookmarkMaterializationOptions,
} from "./bookmarks/index.js";
export {
  classifySessionTags,
  ensurePrivateDirectory,
  getSmartTagSourceTimestamp,
  SMART_TAG_CLASSIFIER_REVISION,
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
  synchronizePricingGeneration,
  type PricingGeneration,
} from "./pricing/index.js";
export { buildDashboard, getSessionActivityTime } from "./analytics/dashboard.js";
export type { DashboardData, DashboardScope } from "./analytics/dashboard.js";
export { attachProjectMetrics } from "./analytics/projects.js";
export { executeSessionSearch, filterSessionSearchCandidates } from "./search/index.js";
