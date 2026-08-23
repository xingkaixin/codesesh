export { firstExisting, readEnvPath, resolveDataHome, resolveHomePath } from "./paths.js";
export { filterSessions, scanSessions } from "./scanner.js";
export {
  ensureSessionTags,
  ensureSessionTagsSync,
  hasStaleSessionTags,
  inheritSessionTags,
} from "./session-tags.js";
export type { AgentCacheFailure, LiveSnapshot, ScanOptions } from "./scanner.js";
export type { SessionTagTiming } from "./session-tags.js";
export {
  commitAgentRefreshCheck,
  executeAgentScanPlan,
  inspectAgentRefresh,
  planAgentScan,
  resolveSessionSnapshotCompleteness,
  selectAgentRefresh,
} from "./agent-scan-plan.js";
export type {
  AgentRefreshInspection,
  AgentRefreshSelection,
  AgentScanIntent,
  AgentScanPlan,
  AgentScanPlanExecution,
  ExecutableAgentScanPlan,
} from "./agent-scan-plan.js";
export {
  materializeSessionDetail,
  materializeSessionDetailResponse,
  type SessionDetailResponseResult,
  type SessionDetailResult,
} from "./session-detail.js";
export type { SessionReference } from "../contract/index.js";
export {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  buildSessionPersistenceDiff,
  computeSessionDiff,
  sessionSignature,
  sortSessions,
} from "./orchestrate.js";
export type { SessionPersistenceDiff, SessionPersistenceDiffOptions } from "./orchestrate.js";
export { mergeSortedSessions } from "../contract/session-index.js";
export {
  clearCache,
  getAgentFullSyncCursor,
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  readAgentCacheInitialization,
  readAgentLastFullSyncAt,
  loadCachedSessionData,
  loadCachedSessionDataEntry,
  loadCachedSessionHeads,
  readCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "./cache/sessions.js";
export type {
  CachedResult,
  CachedSessionDataEntry,
  SaveCachedSessionsOptions,
  SessionSnapshotCompleteness,
} from "./cache/sessions.js";
export type { CacheReadOutcome } from "./cache/connection.js";
export { closeCacheStorage, getCachePath } from "./cache/db.js";
export type { PersistedSessionHeadChange } from "./cache/db.js";
export { getAnalyticsRevision } from "./cache/analytics-revision.js";
export { listCachedProjectGroups } from "./cache/project-groups.js";
export {
  listFileActivity,
  listSessionFileActivity,
  searchFileActivitySessions,
} from "./cache/file-activity.js";
export type { FileActivityOptions, FileActivityResult } from "./cache/file-activity.js";
export { listDashboardCostFacts } from "./cache/cost-facts.js";
export type { CostFactOptions } from "./cache/cost-facts.js";
export { listModelCostDistribution } from "./cache/model-cost.js";
export type { ModelCostEntry, ModelCostOptions } from "./cache/model-cost.js";
export { commitDurableSessionPublication } from "./cache/publication.js";
export type {
  DurableSessionPublication,
  DurableSessionPublicationCommitResult,
  DurableSessionPublicationFailureStage,
} from "./cache/publication.js";
export {
  getSearchProjectDirectory,
  mergeSearchQueryOptions,
  parseSearchQuery,
  readPendingSearchIndexMaintenance,
  searchSessions,
  sessionDetailVersion,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./cache/search.js";
export type {
  ParsedSearchQuery,
  SearchIndexPublicationStage,
  SearchIndexSyncOptions,
  PendingSearchIndexMaintenance,
  SearchIndexSyncFailure,
  SearchIndexSyncResult,
  SearchMatchType,
  SearchOptions,
  SearchRequestOptions,
  SearchQueryFilters,
} from "./cache/search.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
