export { resolveProviderRoots, getCursorDataPath, firstExisting } from "./paths.js";
export type { ProviderRoots } from "./paths.js";
export { filterSessions, scanSessions, scanSessionsAsync } from "./scanner.js";
export type { ScanResult, ScanOptions } from "./scanner.js";
export {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  sessionSignature,
  sortSessions,
} from "./orchestrate.js";
export {
  loadCachedSessions,
  loadCachedSessionData,
  isAgentCacheInitialized,
  markAgentCacheInitialized,
  getAgentLastFullSyncAt,
  markAgentFullSyncCompleted,
  saveCachedSessions,
  saveCachedSessionChanges,
  clearCache,
  getCacheInfo,
  listCachedProjectGroups,
  listFileActivity,
  listSessionFileActivity,
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
} from "./cache.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
