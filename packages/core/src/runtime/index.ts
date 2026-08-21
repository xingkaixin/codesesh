export type {
  FileActivityKind,
  IdentifiedSessionDetail,
  IdentifiedSessionHead,
  ProjectIdentityRef,
  SessionDetail,
  SessionHead,
  SessionReference,
  SmartTag,
} from "../types/index.js";
export {
  BaseAgent,
  createRegisteredAgents,
  FileSystemSessionSource,
  getAgentInfoMap,
  getRegisteredAgents,
  reportSessionSourceOutcome,
  synchronizeSessionSources,
} from "../agents/index.js";
export type {
  AgentScanFailure,
  AgentRoots,
  AgentScanOptions,
  AgentScanProgress,
  AggregateSessionSourceCapability,
  ChangeCheckFailure,
  ChangeCheckResult,
  EnumeratedSessionSourceCapability,
  SessionCacheMeta,
  SessionSourceFailure,
  SessionSourceAbsenceOutcome,
  SessionSourceOutcome,
  SessionSourceScanBatch,
  SessionSourceCapability,
  SessionSourceRef,
  SessionSourceSynchronizationAdapter,
  SessionSourceSynchronizationBaseline,
  SessionSourceSynchronizationOutcome,
  SessionSourceSynchronizationRequest,
  SessionWatchPlan,
} from "../agents/index.js";
export {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  clearCache,
  closeCacheStorage,
  commitDurableSessionPublication,
  computeSessionDiff,
  ensureSessionTagsSync,
  getAgentFullSyncCursor,
  getAnalyticsRevision,
  getSearchProjectDirectory,
  readAgentCacheInitialization,
  readAgentLastFullSyncAt,
  listCachedProjectGroups,
  listDashboardCostFacts,
  listFileActivity,
  listModelCostDistribution,
  loadCachedSessions,
  planAgentScan,
  readCachedSessions,
  loadCachedSessionHeads,
  markAgentCacheInitialized,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  materializeSessionDetailResponse,
  mergeSearchQueryOptions,
  inspectAgentRefresh,
  readPendingSearchIndexMaintenance,
  mergeSortedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
  scanSessions,
  sessionDetailVersion,
  sessionSignature,
  sortSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "../discovery/index.js";
export type { CacheReadOutcome } from "../discovery/index.js";
export { PRICING_CAPTURE_EPOCH } from "../pricing/index.js";
export { filterSessionTreeByActivityWindow } from "../contract/index.js";
export type {
  AgentScanIntent,
  AgentScanPlan,
  AgentRefreshInspection,
  FileActivityResult,
  AgentCacheFailure,
  LiveSnapshot,
  SaveCachedSessionsOptions,
  ScanOptions,
  SessionSnapshotCompleteness,
  DurableSessionPublication,
  DurableSessionPublicationCommitResult,
  DurableSessionPublicationFailureStage,
  PendingSearchIndexMaintenance,
  SearchIndexSyncOptions,
  SearchIndexSyncFailure,
  SearchIndexSyncResult,
  SearchOptions,
  SearchRequestOptions,
  PersistedSessionHeadChange,
  SessionTagTiming,
} from "../discovery/index.js";
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
} from "../state/index.js";
export type { BookmarkRecord, SessionAlias } from "../state/index.js";
export type {
  AvailableBookmarkView,
  BookmarkView,
  UnavailableBookmarkView,
} from "../contract/index.js";
export {
  materializeBookmarkViews,
  type BookmarkMaterializationOptions,
} from "../bookmarks/index.js";
export {
  classifySessionTags,
  ensurePrivateDirectory,
  getSmartTagSourceTimestamp,
  isWorkerLogMessage,
  SMART_TAG_CLASSIFIER_REVISION,
  perf,
  restrictExistingPrivateFiles,
  restrictPrivateFile,
  setCoreDiagnostics,
  WORKER_LOG_MESSAGE_TYPE,
  type WorkerLogLevel,
  type WorkerLogMessage,
} from "../utils/index.js";
export {
  getPricingGeneration,
  hasPendingPricing,
  publishPendingPricing,
  refreshPricingCache,
  synchronizePricingGeneration,
  type PricingGeneration,
} from "../pricing/index.js";
export { buildDashboard, getSessionActivityTime } from "../analytics/dashboard.js";
export type { DashboardData, DashboardScope } from "../analytics/dashboard.js";
export type { DashboardCostFacts } from "../analytics/cost-facts.js";
export {
  attachProjectMetrics,
  attachProjectMetricsFromTree,
  summarizeProjects,
} from "../analytics/projects.js";
export { executeSessionSearch, filterSessionSearchCandidates } from "../search/index.js";
export type { SessionSearchContext, SessionSearchFilterContext } from "../search/index.js";
