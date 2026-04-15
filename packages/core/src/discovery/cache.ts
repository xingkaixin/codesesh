/**
 * 扫描结果缓存 - 将扫描结果持久化到磁盘，加速后续启动
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionHead } from "../types/index.js";

const CACHE_VERSION = 2; // Bumped version for metadata support
const CACHE_FILENAME = "scan-cache.json";

// Session metadata needed for getSessionData
export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  // Additional fields per agent type
  [key: string]: unknown;
}

interface CacheEntry {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>; // keyed by session id
  timestamp: number;
  version: number;
}

interface CacheData {
  version: number;
  entries: Record<string, CacheEntry>; // keyed by agent name
  lastScanTime: number;
}

function getCachePath(): string {
  return join(homedir(), ".cache", "codesesh", CACHE_FILENAME);
}

function ensureCacheDir(): void {
  const cacheDir = join(homedir(), ".cache", "codesesh");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}

export interface CachedResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  timestamp: number;
}

export function loadCachedSessions(agentName: string): CachedResult | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;

    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as CacheData;

    // Version check
    if (data.version !== CACHE_VERSION) return null;

    const entry = data.entries[agentName];
    if (!entry) return null;

    // Check if cache is too old (7 days)
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - entry.timestamp > CACHE_TTL) return null;

    return { sessions: entry.sessions, meta: entry.meta || {}, timestamp: entry.timestamp };
  } catch {
    return null;
  }
}

export function saveCachedSessions(
  agentName: string,
  sessions: SessionHead[],
  meta: Record<string, SessionCacheMeta> = {},
): void {
  try {
    ensureCacheDir();
    const cachePath = getCachePath();

    let data: CacheData;
    if (existsSync(cachePath)) {
      try {
        data = JSON.parse(readFileSync(cachePath, "utf-8")) as CacheData;
        if (data.version !== CACHE_VERSION) {
          data = { version: CACHE_VERSION, entries: {}, lastScanTime: 0 };
        }
      } catch {
        data = { version: CACHE_VERSION, entries: {}, lastScanTime: 0 };
      }
    } else {
      data = { version: CACHE_VERSION, entries: {}, lastScanTime: 0 };
    }

    data.entries[agentName] = {
      sessions,
      meta,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };
    data.lastScanTime = Date.now();

    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Ignore cache write errors
  }
}

export function clearCache(): void {
  try {
    const cachePath = getCachePath();
    if (existsSync(cachePath)) {
      const data: CacheData = {
        version: CACHE_VERSION,
        entries: {},
        lastScanTime: 0,
      };
      writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch {
    // Ignore errors
  }
}

export function getCacheInfo(): { lastScanTime: number | null; size: number } {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) {
      return { lastScanTime: null, size: 0 };
    }

    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as CacheData;
    const size = Object.values(data.entries).reduce((sum, entry) => sum + entry.sessions.length, 0);

    return {
      lastScanTime: data.lastScanTime || null,
      size,
    };
  } catch {
    return { lastScanTime: null, size: 0 };
  }
}
