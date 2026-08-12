/**
 * File activity aggregation: per-session / cross-session file activity queries
 * and file-path search.
 */
import type {
  FileActivityKind,
  ProjectIdentityKind,
  SessionFileActivity,
} from "../../types/index.js";
import type { FileActivityResult } from "../../contract/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { filePathFtsQuery, hasCacheStorage, likePattern, normalizeFilePathSearch } from "./db.js";
import { withCacheDb, withCacheDbReadOnly } from "./schema.js";
import {
  buildSessionSearchFilters,
  mergeSearchQueryOptions,
  sessionHeadFromSearchRow,
  type SearchOptions,
  type SearchResult,
  type SearchResultRow,
} from "./search.js";

export type { FileActivityResult };

export interface FileActivityRow extends SearchResultRow {
  project_identity_key?: string;
  path?: string;
  kind?: FileActivityKind;
  count?: number;
  latest_time?: number;
}

export interface FileActivityOptions {
  agent?: string;
  sessionId?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  project?: string;
  cwd?: string;
  path?: string;
  kind?: FileActivityKind;
  from?: number;
  to?: number;
  limit?: number;
}

export function fileActivityFilters(options: FileActivityOptions): {
  projectKind: ProjectIdentityKind | null;
  projectKey: string | null;
  projectLike: string | null;
  cwdKind: ProjectIdentityKind | null;
  cwdKey: string | null;
  cwdLike: string | null;
  path: string;
  pathLike: string | null;
} {
  const path = options.path ? normalizeFilePathSearch(options.path) : "";
  const cwdIdentity = options.cwd ? computeIdentity(options.cwd, realFs) : null;
  return {
    projectKind: options.projectKind ?? null,
    projectKey: options.projectKey ?? null,
    projectLike: options.project ? likePattern(options.project) : null,
    cwdKind: cwdIdentity?.kind ?? null,
    cwdKey: cwdIdentity?.key ?? null,
    cwdLike: options.cwd ? likePattern(options.cwd) : null,
    path,
    pathLike: path ? likePattern(path) : null,
  };
}

export function fileActivityFromRow(row: FileActivityRow): SessionFileActivity {
  return {
    reference: {
      agentName: String(row.agent_name),
      sessionId: String(row.session_id),
    },
    projectIdentityKey: String(row.project_identity_key ?? ""),
    path: String(row.path ?? ""),
    kind: (row.kind ?? "read") as FileActivityKind,
    count: Number(row.count ?? 0),
    latestTime: Number(row.latest_time ?? 0),
  };
}

export function buildFileActivityWhere(options: FileActivityOptions): {
  where: string;
  params: unknown[];
} {
  const filters = fileActivityFilters(options);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.agent != null) {
    clauses.push("fa.agent_name = ?");
    params.push(options.agent);
  }
  if (options.sessionId != null) {
    clauses.push("fa.session_id = ?");
    params.push(options.sessionId);
  }
  if (filters.projectKind != null || filters.projectKey != null) {
    if (filters.projectKind != null && filters.projectKey != null) {
      clauses.push("s.project_identity_kind = ? AND fa.project_identity_key = ?");
      params.push(filters.projectKind, filters.projectKey);
    } else {
      clauses.push("0");
    }
  }
  if (filters.projectLike != null) {
    clauses.push(
      "(LOWER(fa.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    params.push(filters.projectLike, filters.projectLike, filters.projectLike);
  }
  if (filters.cwdKey != null) {
    clauses.push(
      "((s.project_identity_kind = ? AND s.project_identity_key = ?) OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    params.push(filters.cwdKind, filters.cwdKey, filters.cwdLike);
  }
  if (filters.pathLike != null) {
    const pathQuery = filePathFtsQuery(filters.path);
    if (pathQuery) {
      clauses.push(
        "fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
      );
      params.push(pathQuery);
    } else {
      clauses.push("LOWER(fa.path) LIKE ? ESCAPE '\\'");
      params.push(filters.pathLike);
    }
  }
  if (options.kind != null) {
    clauses.push("fa.kind = ?");
    params.push(options.kind);
  }
  if (options.from != null) {
    clauses.push("fa.latest_time >= ?");
    params.push(options.from);
  }
  if (options.to != null) {
    clauses.push("fa.latest_time <= ?");
    params.push(options.to);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

const FILE_ACTIVITY_COLUMNS = `
  fa.agent_name,
  fa.session_id,
  fa.project_identity_key,
  fa.path,
  fa.kind,
  fa.count,
  fa.latest_time,
  s.slug,
  s.title,
  s.directory,
  s.project_identity_kind,
  s.project_display_name,
  s.time_created,
  s.time_updated,
  s.message_count,
  s.total_input_tokens,
  s.total_output_tokens,
  s.total_cache_read_tokens,
  s.total_cache_create_tokens,
  s.total_cost,
  s.cost_source,
  s.total_tokens,
  s.model_usage_json,
  s.smart_tags_json,
  s.smart_tags_source_updated_at
`;

const FILE_ACTIVITY_JOIN = `
  FROM session_file_activity fa
  JOIN sessions s
    ON s.agent_name = fa.agent_name
    AND s.session_id = fa.session_id
    AND s.publication_id IS NULL
`;

/** Most recent first, then busiest, then path — the tie-break every caller relies on. */
const FILE_ACTIVITY_ORDER = "fa.latest_time DESC, fa.count DESC, fa.path";

export function listFileActivity(options: FileActivityOptions = {}): FileActivityResult[] {
  return queryFileActivity(options);
}

interface FileActivityQuery {
  options: FileActivityOptions;
  sessionSearchOptions?: SearchOptions;
  /** Keep only each session's top-ranked row, so the limit counts sessions. */
  onePerSession?: boolean;
}

function fileActivityWhere(query: FileActivityQuery): { where: string; params: unknown[] } {
  const filters = buildFileActivityWhere(query.options);
  const sessionFilters = query.sessionSearchOptions
    ? buildSessionSearchFilters(query.sessionSearchOptions)
    : { where: "", params: [] };
  const clauses = [
    filters.where.replace(/^WHERE /, ""),
    sessionFilters.where.replace(/^ AND /, ""),
  ].filter(Boolean);
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params: [...filters.params, ...sessionFilters.params],
  };
}

function fileActivitySql(query: FileActivityQuery, where: string): string {
  if (!query.onePerSession) {
    return `
      SELECT ${FILE_ACTIVITY_COLUMNS}
      ${FILE_ACTIVITY_JOIN}
      ${where}
      ORDER BY ${FILE_ACTIVITY_ORDER}
      LIMIT ?
    `;
  }

  return `
    SELECT ${FILE_ACTIVITY_COLUMNS}
    FROM (
      SELECT
        fa.rowid AS activity_rowid,
        ROW_NUMBER() OVER (
          PARTITION BY fa.agent_name, fa.session_id
          ORDER BY ${FILE_ACTIVITY_ORDER}
        ) AS session_rank
      ${FILE_ACTIVITY_JOIN}
      ${where}
    ) ranked
    JOIN session_file_activity fa ON fa.rowid = ranked.activity_rowid
    JOIN sessions s
      ON s.agent_name = fa.agent_name
      AND s.session_id = fa.session_id
      AND s.publication_id IS NULL
    WHERE ranked.session_rank = 1
    ORDER BY ${FILE_ACTIVITY_ORDER}
    LIMIT ?
  `;
}

function queryFileActivity(
  options: FileActivityOptions,
  sessionSearchOptions?: SearchOptions,
  onePerSession = false,
): FileActivityResult[] {
  if (!hasCacheStorage()) {
    return [];
  }

  const query: FileActivityQuery = { options, sessionSearchOptions, onePerSession };
  const { where, params } = fileActivityWhere(query);
  const sql = fileActivitySql(query, where);
  const queryRows = (db: SQLiteDatabase) =>
    db.prepare(sql).all(...params, options.limit ?? 50) as FileActivityRow[];

  const read = withCacheDbReadOnly(queryRows);
  const rows =
    read.status === "success" ? read.value : options.path ? withCacheDb(queryRows) : null;

  return (rows ?? []).map((row) => ({
    ...fileActivityFromRow(row),
    session: sessionHeadFromSearchRow(row),
  }));
}

export function listSessionFileActivity(
  agentName: string,
  sessionId: string,
): SessionFileActivity[] {
  return listFileActivity({ agent: agentName, sessionId, limit: 500 }).map(
    ({ session: _session, ...activity }) => activity,
  );
}

export function highlightFilePath(path: string, query: string): string {
  const needle = normalizeFilePathSearch(query);
  if (!needle) return path;
  const lower = path.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return path;
  return `${path.slice(0, index)}<mark>${path.slice(index, index + needle.length)}</mark>${path.slice(
    index + needle.length,
  )}`;
}

export function searchFileActivitySessions(
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const path = normalizeFilePathSearch(search.options.file ?? search.text);
  if (!path) return [];

  const rows = queryFileActivity(
    {
      path,
      kind: search.options.fileKind,
      limit: search.options.limit ?? 50,
    },
    search.options,
    true,
  );

  return rows.map((row) => ({
    reference: row.reference,
    session: row.session,
    snippet: `${row.kind} ${highlightFilePath(row.path, path)} · ${row.count} events`,
    matchType: "file_path",
  }));
}
