/**
 * File activity aggregation: per-session / cross-session file activity queries
 * and file-path search.
 */
import type { FileActivityKind, SessionFileActivity, SessionHead } from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { filePathFtsQuery, hasCacheStorage, likePattern, normalizeFilePathSearch } from "./db.js";
import { withCacheDb, withCacheDbReadOnly } from "./schema.js";
import {
  mergeSearchQueryOptions,
  sessionHeadFromSearchRow,
  sessionMatchesSearchCost,
  type SearchOptions,
  type SearchResult,
  type SearchResultRow,
} from "./search.js";

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
  projectKey?: string;
  project?: string;
  cwd?: string;
  path?: string;
  kind?: FileActivityKind;
  from?: number;
  to?: number;
  limit?: number;
}

export interface FileActivityResult extends SessionFileActivity {
  session: SessionHead;
}

export function fileActivityFilters(options: FileActivityOptions): {
  projectKey: string | null;
  projectLike: string | null;
  cwdKey: string | null;
  cwdLike: string | null;
  path: string;
  pathLike: string | null;
} {
  const path = options.path ? normalizeFilePathSearch(options.path) : "";
  return {
    projectKey: options.projectKey ?? null,
    projectLike: options.project ? likePattern(options.project) : null,
    cwdKey: options.cwd ? computeIdentity(options.cwd, realFs).key : null,
    cwdLike: options.cwd ? likePattern(options.cwd) : null,
    path,
    pathLike: path ? likePattern(path) : null,
  };
}

export function fileActivityFromRow(row: FileActivityRow): SessionFileActivity {
  return {
    agent_name: String(row.agent_name),
    session_id: String(row.session_id),
    project_identity_key: String(row.project_identity_key ?? ""),
    path: String(row.path ?? ""),
    kind: (row.kind ?? "read") as FileActivityKind,
    count: Number(row.count ?? 0),
    latest_time: Number(row.latest_time ?? 0),
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
  if (filters.projectKey != null) {
    clauses.push("fa.project_identity_key = ?");
    params.push(filters.projectKey);
  }
  if (filters.projectLike != null) {
    clauses.push(
      "(LOWER(fa.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    params.push(filters.projectLike, filters.projectLike, filters.projectLike);
  }
  if (filters.cwdKey != null) {
    clauses.push("(s.project_identity_key = ? OR LOWER(s.directory) LIKE ? ESCAPE '\\')");
    params.push(filters.cwdKey, filters.cwdLike);
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

export function listFileActivity(options: FileActivityOptions = {}): FileActivityResult[] {
  if (!hasCacheStorage()) {
    return [];
  }

  const filters = buildFileActivityWhere(options);
  const queryRows = (db: SQLiteDatabase) =>
    db
      .prepare(
        `
          SELECT
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
            s.total_tokens
          FROM session_file_activity fa
          JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
          ${filters.where}
          ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
          LIMIT ?
        `,
      )
      .all(...filters.params, options.limit ?? 50) as FileActivityRow[];

  let rows = withCacheDbReadOnly(queryRows);
  if (rows == null && options.path) {
    rows = withCacheDb(queryRows);
  }

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

  const rows = listFileActivity({
    agent: search.options.agent,
    projectKey: search.options.projectKey,
    project: search.options.project,
    cwd: search.options.cwd,
    path,
    kind: search.options.fileKind,
    from: search.options.from,
    to: search.options.to,
    limit: (search.options.limit ?? 50) * 3,
  });
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const row of rows) {
    const key = `${row.agent_name}/${row.session_id}`;
    if (seen.has(key)) continue;
    if (!sessionMatchesSearchCost(row.session, search.options)) continue;
    seen.add(key);
    results.push({
      agentName: row.agent_name,
      session: row.session,
      snippet: `${row.kind} ${highlightFilePath(row.path, path)} · ${row.count} events`,
      matchType: "file_path",
    });
    if (results.length >= (search.options.limit ?? 50)) break;
  }

  return results;
}
