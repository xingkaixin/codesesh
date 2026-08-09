export { firstExisting, readEnvPath, resolveDataHome, resolveHomePath } from "./paths.js";
export { ensureSessionTagsSync, filterSessions, scanSessions } from "./scanner.js";
export type { LiveSnapshot, ScanOptions, SessionTagTiming } from "./scanner.js";
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
  computeSessionDiff,
  sessionSignature,
  sortSessions,
} from "./orchestrate.js";
export { mergeSortedSessions } from "../contract/session-index.js";
export {
  clearCache,
  getAgentFullSyncCursor,
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  loadCachedSessionData,
  loadCachedSessionDataEntry,
  loadCachedSessionHeads,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "./cache/sessions.js";
export type {
  CachedSessionDataEntry,
  SaveCachedSessionsOptions,
  SessionSnapshotCompleteness,
} from "./cache/sessions.js";
export { getCachePath } from "./cache/db.js";
export type { SessionHeadChange } from "./cache/db.js";
export { listCachedProjectGroups } from "./cache/project-groups.js";
export {
  listFileActivity,
  listSessionFileActivity,
  searchFileActivitySessions,
} from "./cache/file-activity.js";
export type { FileActivityOptions, FileActivityResult } from "./cache/file-activity.js";
export { listModelCostDistribution } from "./cache/model-cost.js";
export type { ModelCostEntry, ModelCostOptions } from "./cache/model-cost.js";
export { commitDurableSessionPublication } from "./cache/publication.js";
export type {
  DurableSessionPublication,
  DurableSessionPublicationCommitResult,
  DurableSessionPublicationFailureStage,
} from "./cache/publication.js";
export {
  mergeSearchQueryOptions,
  parseSearchQuery,
  searchSessions,
  sessionDetailVersion,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./cache/search.js";
export type {
  ParsedSearchQuery,
  SearchIndexSyncOptions,
  SearchIndexSyncFailure,
  SearchIndexSyncResult,
  SearchMatchType,
  SearchOptions,
  SearchQueryFilters,
} from "./cache/search.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
