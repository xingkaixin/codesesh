/**
 * SQLite helper — graceful degradation if better-sqlite3 is unavailable.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

interface SQLiteStatement {
  all(...params: unknown[]): DatabaseRow[];
  get(...params: unknown[]): DatabaseRow | undefined;
  run(...params: unknown[]): unknown;
}

interface SQLiteTransaction {
  (...params: unknown[]): unknown;
}

interface SQLitePragmaCapable {
  pragma(sql: string): unknown;
}

type SQLiteDatabaseConstructor = (
  path: string,
  options?: { readonly?: boolean },
) => SQLiteDatabase & SQLitePragmaCapable;

let DatabaseConstructor: SQLiteDatabaseConstructor | null = null;

try {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("better-sqlite3");
  DatabaseConstructor = (typeof mod === "function"
    ? mod
    : (mod as { default?: unknown }).default) as SQLiteDatabaseConstructor;
} catch {
  // better-sqlite3 not installed — adapters that need SQLite will gracefully skip
}

export interface DatabaseRow {
  [key: string]: unknown;
}

export interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
  transaction<T extends SQLiteTransaction>(fn: T): T;
  close(): void;
}

/**
 * Open a SQLite database in read-only mode.
 * Returns null if better-sqlite3 is unavailable or the file can't be opened.
 */
export function openDbReadOnly(dbPath: string): SQLiteDatabase | null {
  if (!DatabaseConstructor) return null;
  try {
    const db = DatabaseConstructor(dbPath, { readonly: true });
    return db;
  } catch {
    return null;
  }
}

export function openDb(dbPath: string): SQLiteDatabase | null {
  if (!DatabaseConstructor) return null;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = DatabaseConstructor(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch {
    return null;
  }
}

/**
 * Check if SQLite support is available.
 */
export function isSqliteAvailable(): boolean {
  return DatabaseConstructor !== null;
}
