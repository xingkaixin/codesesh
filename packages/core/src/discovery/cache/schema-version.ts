import type { ProjectIdentity, SessionHead } from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import {
  columnExists,
  getUserVersion,
  tableExists,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../../utils/sqlite.js";

export interface ProjectBackfillSessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  session_json?: string;
  meta_json?: string | null;
  sort_index?: number;
}
export type LegacyProjectIdentityResolver = (directory: string) => ProjectIdentity;

// Schema migrations hold an immediate SQLite transaction, so identity discovery
// must complete before the migration runner starts one.
export function prepareLegacyProjectIdentityResolver(
  db: SQLiteDatabase,
  currentVersion: number,
): LegacyProjectIdentityResolver {
  const directories = new Set<string>();

  if (currentVersion < 7 && tableExists(db, "cached_sessions")) {
    const rows = db
      .prepare("SELECT agent_name, session_id, session_json FROM cached_sessions")
      .all() as ProjectBackfillSessionRow[];
    for (const row of rows) {
      if (!row.session_json) continue;
      try {
        const session = JSON.parse(row.session_json) as SessionHead;
        if (session.directory != null) {
          directories.add(String(session.directory));
        } else {
          getCoreDiagnostics()?.warn("sqlite.migration.identity_precompute.missing_directory", {
            agent_name: row.agent_name,
            session_id: row.session_id,
          });
        }
      } catch {
        continue;
      }
    }
  }

  if (currentVersion < 12) {
    for (const table of ["session_documents", "sessions", "project_sessions"]) {
      if (!tableExists(db, table) || !columnExists(db, table, "directory")) continue;
      const rows = db.prepare(`SELECT directory FROM ${table}`).all() as Array<{
        directory?: unknown;
      }>;
      for (const row of rows) directories.add(String(row.directory ?? ""));
    }
  }

  const identities = new Map<string, ProjectIdentity | Error>();
  for (const directory of directories) {
    try {
      identities.set(directory, computeIdentity(directory, realFs));
    } catch (error) {
      identities.set(directory, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return (directory) => {
    const identity = identities.get(directory);
    if (identity instanceof Error) throw identity;
    if (identity) return identity;
    throw new Error(`Missing precomputed project identity for legacy directory: ${directory}`);
  };
}

export function readLegacyCacheVersion(db: SQLiteDatabase): number {
  if (
    !tableExists(db, "cache_meta") ||
    !columnExists(db, "cache_meta", "key") ||
    !columnExists(db, "cache_meta", "value")
  ) {
    return 0;
  }

  const versionRow = db.prepare("SELECT value FROM cache_meta WHERE key = 'version'").get() as
    | DatabaseRow
    | undefined;
  return Number(versionRow?.value ?? 0);
}

function inferCacheSchemaVersion(db: SQLiteDatabase): number {
  if (columnExists(db, "session_documents", "indexed_message_count")) {
    return columnExists(db, "session_documents", "slug") ? 14 : 15;
  }
  if (tableExists(db, "message_tools")) {
    return 11;
  }
  if (tableExists(db, "session_file_activity_path_fts")) {
    return 10;
  }
  if (tableExists(db, "messages_fts")) {
    return 9;
  }
  if (tableExists(db, "session_file_activity")) {
    return 8;
  }
  if (tableExists(db, "sessions") || tableExists(db, "messages")) {
    return 7;
  }
  if (
    tableExists(db, "project_sessions") ||
    columnExists(db, "session_documents", "project_identity_key")
  ) {
    return 5;
  }
  if (tableExists(db, "session_documents")) {
    return 4;
  }
  if (tableExists(db, "cached_sessions") || tableExists(db, "agent_cache")) {
    return 3;
  }
  return 0;
}

export function getCurrentCacheSchemaVersion(db: SQLiteDatabase): number {
  const userVersion = getUserVersion(db);
  if (userVersion > 0) {
    return userVersion;
  }

  const legacyVersion = readLegacyCacheVersion(db);
  return Math.max(legacyVersion, inferCacheSchemaVersion(db));
}

export function hasAnyCacheSchema(db: SQLiteDatabase): boolean {
  return [
    "cache_meta",
    "agent_cache",
    "cached_sessions",
    "sessions",
    "messages",
    "message_tools",
    "session_file_activity",
    "session_file_activity_path_fts",
    "session_documents",
    "session_documents_fts",
    "project_sessions",
  ].some((table) => tableExists(db, table));
}
