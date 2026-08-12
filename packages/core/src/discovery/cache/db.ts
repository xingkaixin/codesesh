/** Cache paths, process-local connections, and shared query helpers. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import { openDb, type DatabaseRow, type SQLiteDatabase } from "../../utils/sqlite.js";
import type { SessionHead } from "../../types/index.js";

const CACHE_FILENAME = "codesesh.db";
const LEGACY_CACHE_FILENAME = "scan-cache.json";
export const SEARCH_INDEX_BULK_SYNC_THRESHOLD = 100;

export interface SessionHeadChange {
  session: SessionHead;
  sortIndex: number;
}

export interface ScalarRow extends DatabaseRow {
  value?: number;
}

export interface CacheRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  session_json?: string;
  meta_json?: string | null;
  sort_index?: number;
}

export type SQLiteStatement = ReturnType<SQLiteDatabase["prepare"]>;

export interface CacheConnection {
  db: SQLiteDatabase;
  ftsReady: boolean;
  publicationStagingCleaned: boolean;
}

const cacheConnections = new Map<string, CacheConnection>();
let schemaEnsuredPath: string | null = null;

export function getCacheConnection(path: string): CacheConnection | null {
  const cached = cacheConnections.get(path);
  if (cached) return cached;

  const db = openDb(path);
  if (!db) return null;

  const connection = { db, ftsReady: false, publicationStagingCleaned: false };
  cacheConnections.set(path, connection);
  return connection;
}

export function discardCacheConnection(path: string, connection: CacheConnection): void {
  if (cacheConnections.get(path) !== connection) return;
  cacheConnections.delete(path);
  closeConnection(path, connection);
}

function closeConnection(path: string, connection: CacheConnection): void {
  try {
    connection.db.close();
  } catch (error) {
    getCoreDiagnostics()?.warn("cache.close_failed", {
      dbPath: path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function closeCacheStorage(): void {
  const connections = [...cacheConnections];
  cacheConnections.clear();
  schemaEnsuredPath = null;
  for (const [path, connection] of connections) closeConnection(path, connection);
}

export function getSchemaEnsuredPath(): string | null {
  return schemaEnsuredPath;
}

export function setSchemaEnsuredPath(path: string | null): void {
  if (path === null) {
    closeCacheStorage();
    return;
  }
  schemaEnsuredPath = path;
}

export function getCacheDir(): string {
  return join(homedir(), ".cache", "codesesh");
}

export function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILENAME);
}

export function getLegacyCachePath(): string {
  return join(getCacheDir(), LEGACY_CACHE_FILENAME);
}

export function hasCacheStorage(): boolean {
  return existsSync(getCachePath());
}

export function likePattern(value: string): string {
  return `%${value
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, "\\$&")}%`;
}

export function filePathFtsQuery(value: string): string | null {
  const path = normalizeFilePathSearch(value);
  if (path.length < 3) return null;
  return `"${path.replaceAll('"', '""')}"`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeFilePathSearch(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}
