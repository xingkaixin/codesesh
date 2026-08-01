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
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  loadCachedSessionData,
  loadCachedSessionDataEntry,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "./cache/sessions.js";
export type { CachedSessionDataEntry } from "./cache/sessions.js";
export { getCachePath } from "./cache/db.js";
export type { SessionHeadChange } from "./cache/db.js";
export { listCachedProjectGroups } from "./cache/project-groups.js";
export {
  listFileActivity,
  listSessionFileActivity,
  searchFileActivitySessions,
} from "./cache/file-activity.js";
export type { FileActivityOptions, FileActivityResult } from "./cache/file-activity.js";
export {
  mergeSearchQueryOptions,
  parseSearchQuery,
  searchSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./cache/search.js";
export type {
  ParsedSearchQuery,
  SearchIndexSyncOptions,
  SearchIndexSyncResult,
  SearchMatchType,
  SearchOptions,
  SearchQueryFilters,
} from "./cache/search.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
