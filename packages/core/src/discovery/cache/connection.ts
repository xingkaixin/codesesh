/**
 * Cache connection boundary. It owns connection recovery and exposes ready
 * database capabilities while schema creation and FTS repair remain in schema.
 */
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import {
  discardCacheConnection,
  getCacheConnection,
  getCachePath,
  getSchemaEnsuredPath,
  hasCacheStorage,
  setSchemaEnsuredPath,
  type CacheConnection,
} from "./db.js";
import { CacheDataIntegrityError } from "./errors.js";
import { deleteLegacyPublicationRows, hasLegacyPublicationRows } from "./publication-staging.js";
import { ensureCacheSchema, runWithFtsRecovery } from "./schema.js";

type CacheFailureEvent = "cache.write_failed" | "cache.read_failed";

function isRecoverableCacheError(error: unknown): boolean {
  if (error instanceof CacheDataIntegrityError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_")
  );
}

function reportCacheFailure(
  cachePath: string,
  connection: CacheConnection,
  event: CacheFailureEvent,
  error: unknown,
): null {
  getCoreDiagnostics()?.warn(event, {
    message: error instanceof Error ? error.message : String(error),
    code: (error as { code?: string })?.code,
    error_class: error instanceof Error ? error.name : typeof error,
    ...(event === "cache.write_failed" && error instanceof Error ? { stack: error.stack } : {}),
  });
  discardCacheConnection(cachePath, connection);
  return null;
}

function withCacheConnection<T>(
  callbackFailureEvent: CacheFailureEvent,
  fn: (connection: CacheConnection) => T,
): T | null {
  const cachePath = getCachePath();
  const connection = getCacheConnection(cachePath);
  if (!connection) return null;

  try {
    if (getSchemaEnsuredPath() !== cachePath) {
      ensureCacheSchema(connection.db, cachePath);
      setSchemaEnsuredPath(cachePath);
    }
  } catch (error) {
    return reportCacheFailure(cachePath, connection, "cache.write_failed", error);
  }

  try {
    return fn(connection);
  } catch (error) {
    if (!isRecoverableCacheError(error)) throw error;
    return reportCacheFailure(cachePath, connection, callbackFailureEvent, error);
  }
}

function cleanPublicationStaging(connection: CacheConnection): void {
  if (connection.publicationStagingCleaned) return;

  const startedAt = performance.now();
  const reclaimed = hasLegacyPublicationRows(connection.db);
  if (reclaimed) {
    connection.db.transaction(() => deleteLegacyPublicationRows(connection.db)).immediate();
  }
  connection.publicationStagingCleaned = true;
  getCoreDiagnostics()?.info?.("sqlite.publication_staging_cleanup.completed", {
    duration_ms: Math.round(performance.now() - startedAt),
    reclaimed,
  });
}

export function withCacheDb<T>(fn: (db: SQLiteDatabase) => T): T | null {
  return withCacheConnection("cache.write_failed", ({ db }) => fn(db));
}

export type CacheReadOutcome<T> = { status: "success"; value: T } | { status: "failed" };

/** Preserves the difference between a failed read and a successful nullish payload. */
export function withCacheDbOutcome<T>(fn: (db: SQLiteDatabase) => T): CacheReadOutcome<T> {
  let outcome: CacheReadOutcome<T> = { status: "failed" };
  withCacheConnection("cache.read_failed", ({ db }) => {
    outcome = { status: "success", value: fn(db) };
  });
  return outcome;
}

export function withCacheDbReadOnly<T>(fn: (db: SQLiteDatabase) => T): CacheReadOutcome<T> {
  const cachePath = getCachePath();
  if (!hasCacheStorage()) return { status: "failed" };

  const connection = getCacheConnection(cachePath);
  if (!connection) return { status: "failed" };
  try {
    return { status: "success", value: fn(connection.db) };
  } catch (error) {
    if (!isRecoverableCacheError(error)) throw error;
    reportCacheFailure(cachePath, connection, "cache.read_failed", error);
    return { status: "failed" };
  }
}

export function withSearchDb<T>(fn: (db: SQLiteDatabase) => T): T | null {
  return withCacheConnection("cache.read_failed", (connection) =>
    runWithFtsRecovery(connection, fn),
  );
}

export function withSearchIndexDb<T>(fn: (db: SQLiteDatabase) => T): T | null {
  return withCacheConnection("cache.write_failed", (connection) => {
    cleanPublicationStaging(connection);
    return runWithFtsRecovery(connection, fn);
  });
}
