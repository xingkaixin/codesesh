/**
 * 扫描结果缓存 - barrel，re-export cache/*.ts 子模块的公共接口。
 * discovery/index.ts 与测试均从此路径导入，故这是稳定的接缝。
 */

export {
  hasCacheStorage,
  getCachePath,
  setFtsIntegrityCheckedPath,
  type SessionCacheMeta,
  type SessionHeadChange,
} from "./cache/db.js";

export {
  CACHE_INITIALIZATION_VERSION,
  clearCache,
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  loadCachedSessionData,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncCompleted,
  saveCachedSessionChanges,
  saveCachedSessions,
  type CachedResult,
} from "./cache/sessions.js";

export {
  mergeSearchQueryOptions,
  parseSearchQuery,
  searchSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type SearchIndexSyncOptions,
  type SearchIndexSyncResult,
  type SearchResult,
  type SearchMatchType,
  type SearchOptions,
  type SearchQueryFilters,
  type ParsedSearchQuery,
} from "./cache/search.js";

export {
  listFileActivity,
  listSessionFileActivity,
  searchFileActivitySessions,
  type FileActivityOptions,
  type FileActivityResult,
} from "./cache/file-activity.js";

export { listCachedProjectGroups } from "./cache/project-groups.js";
