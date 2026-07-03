/**
 * Cache infrastructure: cache paths, shared query helpers, and the FTS
 * integrity-check guard. Lower-level than schema.ts — no DB handles here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import type { SessionHead } from "../../types/index.js";

const CACHE_FILENAME = "codesesh.db";
const LEGACY_CACHE_FILENAME = "scan-cache.json";
export const SEARCH_INDEX_BULK_SYNC_THRESHOLD = 100;

export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  [key: string]: unknown;
}

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

// One-shot per-process FTS integrity check guard; reset by clearCache.
let ftsIntegrityCheckedPath: string | null = null;

export function getFtsIntegrityCheckedPath(): string | null {
  return ftsIntegrityCheckedPath;
}

export function setFtsIntegrityCheckedPath(path: string | null): void {
  ftsIntegrityCheckedPath = path;
}

// One-shot per-process ensureSchema guard; reset by clearCache. Once a path
// has been schema-checked, withCacheDb skips ensureSchema's DDL exec (which
// otherwise runs unconditionally on every open) so read-heavy callers stop
// contending for the write lock.
let schemaEnsuredPath: string | null = null;

export function getSchemaEnsuredPath(): string | null {
  return schemaEnsuredPath;
}

export function setSchemaEnsuredPath(path: string | null): void {
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
