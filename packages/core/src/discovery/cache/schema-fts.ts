import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import { tableExists, type SQLiteDatabase } from "../../utils/sqlite.js";
import type { CacheConnection } from "./db.js";
import {
  createSearchTables,
  createSearchTriggers,
  dropSearchTriggers,
} from "./schema-definitions.js";

interface SearchIndexWriteResult<T> {
  value: T;
  rebuildDurationMs?: number;
}

export function runSearchIndexWrite<T>(
  db: SQLiteDatabase,
  rebuild: boolean,
  write: () => T,
  transaction: "immediate" | "caller" = "immediate",
): SearchIndexWriteResult<T> {
  const execute = () => {
    if (rebuild) {
      dropSearchTriggers(db);
    }

    const value = write();
    let rebuildDurationMs: number | undefined;

    if (rebuild) {
      const rebuildStartedAt = performance.now();
      getCoreDiagnostics()?.info?.("search_index.fts_rebuild.started");
      rebuildSearchIndex(db);
      rebuildDurationMs = performance.now() - rebuildStartedAt;
      getCoreDiagnostics()?.info?.("search_index.fts_rebuild.completed", {
        duration_ms: Math.round(rebuildDurationMs),
      });
      createSearchTriggers(db);
    }

    return { value, rebuildDurationMs };
  };

  return transaction === "caller" ? execute() : db.transaction(execute).immediate();
}

export function rebuildSearchIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents_fts")) {
    return;
  }
  db.exec("INSERT INTO session_documents_fts(session_documents_fts) VALUES ('rebuild')");
}

function triggerExists(db: SQLiteDatabase, triggerName: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS value FROM sqlite_master WHERE name = ? AND type = 'trigger' LIMIT 1")
      .get(triggerName) !== undefined
  );
}

function hasAllTriggers(db: SQLiteDatabase, triggerNames: string[]): boolean {
  return triggerNames.every((triggerName) => triggerExists(db, triggerName));
}

function rebuildSearchFtsIndex(db: SQLiteDatabase, reason: "corruption" | "schema_missing"): void {
  const indexes = ["session_documents_fts"];
  const startedAt = performance.now();
  getCoreDiagnostics()?.info?.("sqlite.fts_rebuild.started", { indexes, reason });
  try {
    rebuildSearchIndex(db);
    getCoreDiagnostics()?.info?.("sqlite.fts_rebuild.completed", {
      indexes,
      reason,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    getCoreDiagnostics()?.warn("sqlite.fts_rebuild.failed", {
      indexes,
      reason,
      duration_ms: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function ensureFtsReady(db: SQLiteDatabase): void {
  const needsSearchRebuild =
    !tableExists(db, "session_documents_fts") ||
    !hasAllTriggers(db, ["session_documents_ai", "session_documents_ad", "session_documents_au"]);

  createSearchTables(db);
  if (needsSearchRebuild) rebuildSearchFtsIndex(db, "schema_missing");
}

function ensureFtsConsistency(db: SQLiteDatabase): void {
  const startedAt = performance.now();
  getCoreDiagnostics()?.info?.("sqlite.fts_integrity.started", {
    indexes: 1,
  });
  try {
    db.exec(
      "INSERT INTO session_documents_fts(session_documents_fts, rank) VALUES ('integrity-check', 1)",
    );
    getCoreDiagnostics()?.info?.("sqlite.fts_integrity.completed", {
      indexes: 1,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    getCoreDiagnostics()?.warn("sqlite.fts_integrity.failed", {
      indexes: 1,
      duration_ms: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
    });
    rebuildSearchFtsIndex(db, "corruption");
  }
}

function isFtsCorruptionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CORRUPT_VTAB"
  );
}

export function runWithFtsRecovery<T>(
  connection: CacheConnection,
  fn: (db: SQLiteDatabase) => T,
): T {
  const { db } = connection;
  if (!connection.ftsReady) {
    ensureFtsReady(db);
    connection.ftsReady = true;
  }
  try {
    return fn(db);
  } catch (error) {
    if (!isFtsCorruptionError(error)) throw error;
    getCoreDiagnostics()?.warn("sqlite.fts_corruption.detected", {
      message: error instanceof Error ? error.message : String(error),
    });
    ensureFtsConsistency(db);
    return fn(db);
  }
}
