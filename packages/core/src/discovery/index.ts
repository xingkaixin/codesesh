export { resolveProviderRoots, getCursorDataPath, firstExisting } from "./paths.js";
export type { ProviderRoots } from "./paths.js";
export { scanSessions, scanSessionsAsync } from "./scanner.js";
export type { ScanResult, ScanOptions } from "./scanner.js";
export { loadCachedSessions, saveCachedSessions, clearCache, getCacheInfo } from "./cache.js";
export { perf } from "../utils/index.js";
export type { PerfMarker } from "../utils/index.js";
