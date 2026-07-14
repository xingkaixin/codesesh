import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  columnExists,
  getUserVersion,
  openDb,
  runSchemaMigrations,
  setUserVersion,
  tableExists,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../utils/sqlite.js";

const STATE_DB_FILENAME = "state.db";
const STATE_SCHEMA_VERSION = 2;
const MEMORY_STATE_STORE = "memory";

export class StateStorageUnavailableError extends Error {
  constructor() {
    super("SQLite state database is unavailable");
    this.name = "StateStorageUnavailableError";
  }
}

function getStateDir(): string {
  if (process.env.CODESESH_STATE_DIR) return process.env.CODESESH_STATE_DIR;

  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codesesh");
  }
  if (currentPlatform === "win32") {
    const appData = process.env.APPDATA ?? process.env.LOCALAPPDATA;
    return join(appData ?? join(homedir(), "AppData", "Roaming"), "codesesh");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "codesesh");
}

function getStateDbPath(): string {
  return join(getStateDir(), STATE_DB_FILENAME);
}

export function useMemoryStateStore(): boolean {
  return process.env.CODESESH_STATE_STORE === MEMORY_STATE_STORE;
}

function createBookmarksTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      stats_json TEXT NOT NULL,
      bookmarked_at INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
  `);
}

function createSessionAliasesTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_aliases (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
  `);
}

function createStateSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  createBookmarksTable(db);
  createSessionAliasesTable(db);
}

function readLegacyStateVersion(db: SQLiteDatabase): number {
  if (
    !tableExists(db, "state_meta") ||
    !columnExists(db, "state_meta", "key") ||
    !columnExists(db, "state_meta", "value")
  ) {
    return 0;
  }

  const row = db.prepare("SELECT value FROM state_meta WHERE key = 'version'").get() as
    | DatabaseRow
    | undefined;
  return Number(row?.value ?? 0);
}

function getCurrentStateSchemaVersion(db: SQLiteDatabase): number {
  const userVersion = getUserVersion(db);
  if (userVersion > 0) return userVersion;

  const legacyVersion = readLegacyStateVersion(db);
  if (legacyVersion > 0) return legacyVersion;

  return tableExists(db, "bookmarks") ? 1 : 0;
}

function hasAnyStateSchema(db: SQLiteDatabase): boolean {
  return tableExists(db, "state_meta") || tableExists(db, "bookmarks");
}

function setStateSchemaVersion(db: SQLiteDatabase): void {
  createStateSchema(db);
  setUserVersion(db, STATE_SCHEMA_VERSION);
  db.prepare(
    `
      INSERT INTO state_meta(key, value)
      VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(String(STATE_SCHEMA_VERSION));
}

function ensureSchema(db: SQLiteDatabase, dbPath: string): void {
  const currentVersion = getCurrentStateSchemaVersion(db);
  if (currentVersion === 0 && !hasAnyStateSchema(db)) {
    setStateSchemaVersion(db);
    return;
  }

  runSchemaMigrations(db, {
    dbPath,
    currentVersion,
    targetVersion: STATE_SCHEMA_VERSION,
    backupLabel: "state-migration",
    backupTables: ["bookmarks", "session_aliases"],
    migrations: [
      { version: 1, migrate: createBookmarksTable },
      { version: 2, migrate: createSessionAliasesTable },
    ],
  });

  setStateSchemaVersion(db);
}

export function withStateDb<T>(fn: (db: SQLiteDatabase) => T): T {
  const statePath = getStateDbPath();
  const db = openDb(statePath);
  if (!db) throw new StateStorageUnavailableError();

  try {
    ensureSchema(db, statePath);
    return fn(db);
  } finally {
    db.close();
  }
}
