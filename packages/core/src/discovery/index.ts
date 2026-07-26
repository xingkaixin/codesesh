export { resolveAgentRoots, getCursorDataPath, firstExisting } from "./paths.js";
export type { AgentRoots } from "./paths.js";
export {
  ensureSessionTagsSync,
  filterSessions,
  scanSessions,
  scanSessionsAsync,
} from "./scanner.js";
export type { LiveSnapshot, ScanOptions } from "./scanner.js";
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
  loadCachedSessions,
  loadCachedSessionData,
  loadCachedSessionDataEntry,
  isAgentCacheInitialized,
  markAgentCacheInitialized,
  getAgentLastFullSyncAt,
  markAgentFullSyncCompleted,
  saveCachedSessions,
  saveCachedSessionChanges,
  clearCache,
  getCacheInfo,
  getCachePath,
  setFtsIntegrityCheckedPath,
  listCachedProjectGroups,
  listFileActivity,
  listSessionFileActivity,
  mergeSearchQueryOptions,
  parseSearchQuery,
  searchFileActivitySessions,
  searchSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "./cache.js";
export type {
  FileActivityOptions,
  FileActivityResult,
  ParsedSearchQuery,
  SearchIndexSyncOptions,
  SearchIndexSyncResult,
  SearchMatchType,
  SearchOptions,
  SearchQueryFilters,
  SessionHeadChange,
  CachedSessionDataEntry,
} from "./cache.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
