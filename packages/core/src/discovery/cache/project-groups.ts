/**
 * Project grouping: reads the project_groups_v view (or falls back to an
 * in-memory build) to list cached project groups.
 */
import type { ProjectGroup, ProjectIdentityKind, SessionHead } from "../../types/index.js";
import { buildProjectGroups } from "../../projects/index.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import { hasCacheStorage } from "./db.js";
import { withCacheDb, withCacheDbReadOnly } from "./schema.js";

export interface ProjectGroupRow extends DatabaseRow {
  identity_kind?: ProjectIdentityKind;
  identity_key?: string;
  display_name?: string;
  sources_csv?: string | null;
  session_count?: number;
  last_activity?: number | null;
}

export function listCachedProjectGroups(sessions?: SessionHead[]): ProjectGroup[] {
  if (sessions) {
    return buildProjectGroups(sessions);
  }

  if (!hasCacheStorage()) {
    return [];
  }

  const queryRows = (db: SQLiteDatabase) =>
    db
      .prepare(
        `
          SELECT identity_kind, identity_key, display_name, sources_csv, session_count, last_activity
          FROM project_groups_v
          ORDER BY
            CASE identity_kind WHEN 'loose' THEN 1 ELSE 0 END,
            last_activity IS NULL,
            last_activity DESC
        `,
      )
      .all() as ProjectGroupRow[];

  let rows = withCacheDbReadOnly(queryRows);
  if (rows == null) {
    rows = withCacheDb(queryRows);
  }

  return (rows ?? []).map((row) => ({
    identityKind: row.identity_kind ?? "path",
    identityKey: String(row.identity_key ?? ""),
    displayName: String(row.display_name ?? ""),
    sources: String(row.sources_csv ?? "")
      .split(",")
      .filter(Boolean)
      .sort(),
    sessionCount: Number(row.session_count ?? 0),
    lastActivity: row.last_activity == null ? null : Number(row.last_activity),
  }));
}
