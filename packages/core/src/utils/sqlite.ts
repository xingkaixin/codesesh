/**
 * SQLite helper — graceful degradation if better-sqlite3 is unavailable.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { getCoreDiagnostics } from "./diagnostics.js";

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
let loadErrorMessage: string | null = null;

try {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("better-sqlite3");
  DatabaseConstructor = (
    typeof mod === "function" ? mod : (mod as { default?: unknown }).default
  ) as SQLiteDatabaseConstructor;
} catch (error) {
  // better-sqlite3 not installed — adapters that need SQLite will gracefully skip.
  // This module body evaluates before a host has a chance to call
  // setCoreDiagnostics, so reporting here would always be dropped — defer the
  // warn to reportUnavailableOnce(), called from the first actual open attempt.
  loadErrorMessage = error instanceof Error ? error.message : String(error);
}

let unavailableReported = false;

function reportUnavailableOnce(): void {
  if (unavailableReported) return;
  unavailableReported = true;
  getCoreDiagnostics()?.warn("sqlite.unavailable", { message: loadErrorMessage });
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

export interface SchemaMigration {
  version: number;
  destructive?: boolean;
  migrate(db: SQLiteDatabase): void;
}

export interface RunSchemaMigrationsOptions {
  dbPath: string;
  currentVersion: number;
  targetVersion: number;
  migrations: SchemaMigration[];
  backupTables: string[];
  backupLabel: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isInMemoryPath(dbPath: string): boolean {
  return (
    dbPath === ":memory:" || dbPath.startsWith("file::memory:") || dbPath.includes("mode=memory")
  );
}

export function getUserVersion(db: SQLiteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as DatabaseRow | undefined;
  return Number(row?.user_version ?? 0);
}

export function setUserVersion(db: SQLiteDatabase, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

export function tableExists(db: SQLiteDatabase, tableName: string): boolean {
  const row = db
    .prepare(
      `
        SELECT 1 AS value
        FROM sqlite_master
        WHERE name = ? AND type IN ('table', 'view')
        LIMIT 1
      `,
    )
    .get(tableName) as DatabaseRow | undefined;
  return row !== undefined;
}

export function columnExists(db: SQLiteDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
  return rows.some((row) => String(row.name) === columnName);
}

export function tableHasRows(db: SQLiteDatabase, tableName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const row = db.prepare(`SELECT 1 AS value FROM ${quoteIdentifier(tableName)} LIMIT 1`).get() as
    | DatabaseRow
    | undefined;
  return row !== undefined;
}

export function backupDatabase(db: SQLiteDatabase, dbPath: string, label: string): string | null {
  if (isInMemoryPath(dbPath)) {
    return null;
  }

  const timestamp = new Date(Date.now()).toISOString().replaceAll(":", "").replaceAll(".", "-");
  let backupPath = join(dirname(dbPath), `${basename(dbPath)}.${timestamp}.${label}.bak`);
  for (let counter = 1; existsSync(backupPath); counter += 1) {
    backupPath = join(dirname(dbPath), `${basename(dbPath)}.${timestamp}.${label}.${counter}.bak`);
  }
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

export function backupDatabaseIfPopulated(
  db: SQLiteDatabase,
  dbPath: string,
  label: string,
  tables: string[],
): string | null {
  if (!tables.some((table) => tableHasRows(db, table))) {
    return null;
  }

  return backupDatabase(db, dbPath, label);
}

export function runSchemaMigrations(
  db: SQLiteDatabase,
  options: RunSchemaMigrationsOptions,
): string[] {
  const backups: string[] = [];
  let currentVersion = options.currentVersion;

  for (const migration of options.migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }
    if (migration.version > options.targetVersion) {
      break;
    }

    if (migration.destructive) {
      const backupPath = backupDatabaseIfPopulated(
        db,
        options.dbPath,
        options.backupLabel,
        options.backupTables,
      );
      if (backupPath) {
        backups.push(backupPath);
      }
    }

    const apply = db.transaction(() => {
      migration.migrate(db);
      setUserVersion(db, migration.version);
    });
    apply();
    currentVersion = migration.version;
  }

  if (currentVersion < options.targetVersion) {
    setUserVersion(db, options.targetVersion);
  }

  return backups;
}

/**
 * Open a SQLite database in read-only mode.
 * Returns null if better-sqlite3 is unavailable or the file can't be opened.
 */
export function openDbReadOnly(dbPath: string): SQLiteDatabase | null {
  if (!DatabaseConstructor) {
    reportUnavailableOnce();
    return null;
  }
  try {
    const db = DatabaseConstructor(dbPath, { readonly: true });
    return db;
  } catch (error) {
    getCoreDiagnostics()?.warn("sqlite.open_failed", {
      dbPath,
      readonly: true,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function openDb(dbPath: string): SQLiteDatabase | null {
  if (!DatabaseConstructor) {
    reportUnavailableOnce();
    return null;
  }
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = DatabaseConstructor(dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("foreign_keys = ON");
    } catch {
      // The database remains usable when SQLite rejects connection-level tuning.
    }
    return db;
  } catch (error) {
    getCoreDiagnostics()?.warn("sqlite.open_failed", {
      dbPath,
      readonly: false,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check if SQLite support is available.
 */
export function isSqliteAvailable(): boolean {
  return DatabaseConstructor !== null;
}
