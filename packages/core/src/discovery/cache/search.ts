/**
 * Full-text query reader and the stable search cache export surface.
 */
import type {
  FileActivityKind,
  Message,
  ProjectIdentityKind,
  SessionHead,
  SmartTag,
} from "../../types/index.js";
import type { SearchHighlightRange, SearchMatchType, SearchResult } from "../../contract/index.js";
import { normalizeProjectScopePath, type ProjectScopeMatcher } from "../../projects/scope.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import { escapeRegExp, filePathFtsQuery, hasCacheStorage, likePattern } from "./db.js";
import { normalizeToolName, sessionFromRow, type SessionRow } from "./messages.js";
import { withSearchDb } from "./schema.js";
import {
  parseSearchQuery,
  splitSearchTokens,
  toFtsQuery,
  unwrapSearchValue,
  type ParsedSearchQuery,
  type SearchQueryFilters,
} from "./search-query-parser.js";

interface MessageSearchRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  message_index?: number;
  role?: Message["role"];
  mode?: string | null;
  content_text?: string;
  tool_metadata_json?: string | null;
}

export interface SearchResultRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  project_identity_kind?: ProjectIdentityKind;
  project_identity_key?: string;
  project_display_name?: string;
  time_created?: number;
  time_updated?: number | null;
  message_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number | null;
  total_cache_create_tokens?: number | null;
  total_cost?: number;
  cost_source?: string | null;
  total_tokens?: number | null;
  model_usage_json?: string | null;
  smart_tags_json?: string | null;
  smart_tags_source_updated_at?: number | null;
  snippet?: string | null;
}

export type { SearchMatchType, SearchResult };

export { parseSearchQuery, type ParsedSearchQuery, type SearchQueryFilters };

export interface SearchOptions {
  agent?: string;
  project?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  projectScope?: ProjectScopeMatcher;
  tags?: SmartTag[];
  tools?: string[];
  file?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
  costMinExclusive?: boolean;
  costMaxExclusive?: boolean;
  from?: number;
  to?: number;
  limit?: number;
}

export interface SearchRequestOptions extends SearchOptions {
  cwd?: string;
}

export {
  readPendingSearchIndexMaintenance,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type PendingSearchIndexMaintenance,
  type SearchIndexSyncOptions,
  type SearchIndexSyncFailure,
  type SearchIndexSyncResult,
} from "./search-index-writer.js";
export { sessionDetailVersion } from "./detail-version.js";

export function sessionHeadFromSearchRow(row: SearchResultRow): SessionHead {
  return sessionFromRow(row as SessionRow);
}

export function mergeSearchLists<T>(
  left: T[] | undefined,
  right: T[] | undefined,
): T[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function mergeSearchQueryOptions(query: string, options: SearchOptions) {
  const parsed = parseSearchQuery(query);
  return {
    text: parsed.text || (parsed.hasQualifiers ? "" : query.trim()),
    options: {
      ...options,
      agent: options.agent ?? parsed.filters.agent,
      project: options.project ?? parsed.filters.project,
      projectKind: options.projectKind ?? parsed.filters.projectKind,
      projectKey: options.projectKey ?? parsed.filters.projectKey,
      tags: mergeSearchLists(options.tags, parsed.filters.tags),
      tools: mergeSearchLists(options.tools, parsed.filters.tools),
      file: options.file ?? parsed.filters.file,
      fileKind: options.fileKind ?? parsed.filters.fileKind,
      costMin: options.costMin ?? parsed.filters.costMin,
      costMax: options.costMax ?? parsed.filters.costMax,
      costMinExclusive: options.costMinExclusive ?? parsed.filters.costMinExclusive,
      costMaxExclusive: options.costMaxExclusive ?? parsed.filters.costMaxExclusive,
    },
    parsed,
  };
}

export function getSearchProjectDirectory(
  query: string,
  options: SearchRequestOptions,
): string | undefined {
  return options.cwd ?? parseSearchQuery(query).filters.cwd;
}

export function sessionMatchesSearchCost(
  session: SessionHead,
  options: SearchOptions,
  cost = session.stats.total_cost,
): boolean {
  if (options.costMin != null) {
    if (options.costMinExclusive ? cost <= options.costMin : cost < options.costMin) {
      return false;
    }
  }
  if (options.costMax != null) {
    if (options.costMaxExclusive ? cost >= options.costMax : cost > options.costMax) {
      return false;
    }
  }
  return true;
}

export function buildSessionSearchFilters(options: SearchOptions): {
  where: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.agent) {
    clauses.push("s.agent_name = ?");
    params.push(options.agent);
  }
  if (options.projectKind || options.projectKey) {
    if (options.projectKind && options.projectKey) {
      clauses.push("s.project_identity_kind = ? AND s.project_identity_key = ?");
      params.push(options.projectKind, options.projectKey);
    } else {
      clauses.push("0");
    }
  }
  if (options.projectScope) {
    const scopePath = normalizeProjectScopePath(options.projectScope.path).toLowerCase();
    const normalizedDirectory = "REPLACE(LOWER(s.directory), char(92), '/')";
    clauses.push(
      `((s.project_identity_kind = ? AND s.project_identity_key = ?) OR ${normalizedDirectory} = ? OR instr(${normalizedDirectory}, ? || '/') = 1 OR instr(?, ${normalizedDirectory} || '/') = 1)`,
    );
    params.push(
      options.projectScope.identity.kind,
      options.projectScope.identity.key,
      scopePath,
      scopePath,
      scopePath,
    );
  }
  if (options.project) {
    clauses.push(
      "(LOWER(s.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(options.project);
    params.push(pattern, pattern, pattern);
  }
  for (const tag of options.tags ?? []) {
    clauses.push("s.smart_tags_json LIKE ?");
    params.push(`%"${tag}"%`);
  }
  for (const tool of options.tools ?? []) {
    const toolName = normalizeToolName(tool);
    if (!toolName) continue;
    clauses.push(
      "EXISTS (SELECT 1 FROM message_tools mt WHERE mt.tool_name = ? AND mt.agent_name = s.agent_name AND mt.session_id = s.session_id)",
    );
    params.push(toolName);
  }
  if (options.file || options.fileKind) {
    const fileClauses = ["fa.agent_name = s.agent_name", "fa.session_id = s.session_id"];
    if (options.file) {
      const pathQuery = filePathFtsQuery(options.file);
      if (pathQuery) {
        fileClauses.push(
          "fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
        );
        params.push(pathQuery);
      } else {
        fileClauses.push("LOWER(fa.path) LIKE ? ESCAPE '\\'");
        params.push(likePattern(options.file));
      }
    }
    if (options.fileKind) {
      fileClauses.push("fa.kind = ?");
      params.push(options.fileKind);
    }
    clauses.push(
      `EXISTS (SELECT 1 FROM session_file_activity fa WHERE ${fileClauses.join(" AND ")})`,
    );
  }
  if (options.from != null) {
    clauses.push("s.activity_time >= ?");
    params.push(options.from);
  }
  if (options.to != null) {
    clauses.push("s.activity_time <= ?");
    params.push(options.to);
  }
  appendInclusiveCostFilter(clauses, params, options);

  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params,
  };
}

function appendInclusiveCostFilter(
  clauses: string[],
  params: unknown[],
  options: SearchOptions,
): void {
  const predicates: string[] = [];
  if (options.costMin != null) {
    predicates.push(options.costMinExclusive ? "SUM(own_cost) > ?" : "SUM(own_cost) >= ?");
    params.push(options.costMin);
  }
  if (options.costMax != null) {
    predicates.push(options.costMaxExclusive ? "SUM(own_cost) < ?" : "SUM(own_cost) <= ?");
    params.push(options.costMax);
  }
  if (predicates.length === 0) return;

  // UNION makes malformed parent cycles converge while preserving one row per session.
  clauses.push(`EXISTS (
    WITH RECURSIVE session_subtree(agent_name, session_id, own_cost) AS (
      SELECT s.agent_name, s.session_id, s.total_cost
      UNION
      SELECT child.agent_name, child.session_id, child.total_cost
      FROM sessions child
      JOIN session_subtree parent
        ON child.parent_agent_name = parent.agent_name
        AND child.parent_session_id = parent.session_id
      WHERE child.publication_id IS NULL
    )
    SELECT SUM(own_cost)
    FROM session_subtree
    HAVING ${predicates.join(" AND ")}
  )`);
}

export interface SessionSearchReference {
  agentName: string;
  sessionId: string;
}

const SQLITE_REFERENCE_BATCH_SIZE = 200;

export function filterIndexedSessionReferences(
  references: SessionSearchReference[],
  options: SearchOptions,
): Set<string> {
  if (references.length === 0 || !hasCacheStorage()) return new Set();

  const matches = withSearchDb((db) => {
    const filters = buildSessionSearchFilters(options);
    const result = new Set<string>();

    for (let offset = 0; offset < references.length; offset += SQLITE_REFERENCE_BATCH_SIZE) {
      const batch = references.slice(offset, offset + SQLITE_REFERENCE_BATCH_SIZE);
      const referenceClauses = batch.map(() => "(s.agent_name = ? AND s.session_id = ?)");
      const referenceParams = batch.flatMap(({ agentName, sessionId }) => [agentName, sessionId]);
      const rows = db
        .prepare(
          `
            SELECT s.agent_name, s.session_id
            FROM sessions s
            WHERE (${referenceClauses.join(" OR ")})
              AND s.publication_id IS NULL
              ${filters.where}
          `,
        )
        .all(...referenceParams, ...filters.params) as SearchResultRow[];

      for (const row of rows) {
        result.add(searchResultRowKey(row));
      }
    }

    return result;
  });

  return matches ?? new Set();
}

function searchSessionColumns(): string {
  return `
    s.agent_name,
    s.session_id,
    s.slug,
    s.title,
    s.directory,
    s.project_identity_kind,
    s.project_identity_key,
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
}

function parseTextTerms(input: string): { terms: string[]; mode: "all" | "any" } {
  const tokens = splitSearchTokens(input);
  return {
    terms: tokens
      .filter((token) => !/^OR$/i.test(token))
      .map((token) => unwrapSearchValue(token).toLowerCase())
      .filter(Boolean),
    mode: tokens.some((token) => /^OR$/i.test(token)) ? "any" : "all",
  };
}

function textMatchesTerms(text: string, terms: { terms: string[]; mode: "all" | "any" }) {
  const lower = text.toLowerCase();
  if (terms.terms.length === 0) return true;
  if (terms.mode === "any") return terms.terms.some((term) => lower.includes(term));
  return terms.terms.every((term) => lower.includes(term));
}

interface SearchSnippet {
  snippet: string;
  snippetHighlights: SearchHighlightRange[];
}

function findHighlightRanges(text: string, terms: string[]): SearchHighlightRange[] {
  const ranges = terms.flatMap((term) =>
    Array.from(text.matchAll(new RegExp(escapeRegExp(term), "giu")), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  );
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);

  return ranges.reduce<SearchHighlightRange[]>((merged, range) => {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
    return merged;
  }, []);
}

function buildTermSnippet(
  text: string,
  terms: { terms: string[]; mode: "all" | "any" },
): SearchSnippet {
  const lower = text.toLowerCase();
  const term = terms.terms.find((item) => lower.includes(item)) ?? terms.terms[0] ?? "";
  if (!term) {
    return { snippet: text.slice(0, 180), snippetHighlights: [] };
  }

  const index = lower.indexOf(term);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + term.length + 80);
  const snippet = `${start > 0 ? "… " : ""}${text.slice(start, end)}${
    end < text.length ? " …" : ""
  }`;
  return {
    snippet,
    snippetHighlights: findHighlightRanges(snippet, terms.terms),
  };
}

function messageMatchType(row: MessageSearchRow): SearchMatchType {
  if (row.role === "user") return "user_message";
  if (row.role === "tool" || row.mode === "tool" || row.tool_metadata_json) return "tool_output";
  return "assistant_reply";
}

function searchResultRowKey(row: Pick<SearchResultRow, "agent_name" | "session_id">): string {
  return `${String(row.agent_name)}\u0000${String(row.session_id)}`;
}

function fetchMessageSearchMatches(
  db: SQLiteDatabase,
  rows: SearchResultRow[],
  terms: { terms: string[]; mode: "all" | "any" },
): Map<string, SearchSnippet & { matchType: SearchMatchType }> {
  const candidates = rows.filter((row) => !textMatchesTerms(String(row.title ?? ""), terms));
  if (candidates.length === 0) {
    return new Map();
  }

  const candidateValues = candidates.map(() => "(?, ?)").join(", ");
  const candidateParams = candidates.flatMap((row) => [
    String(row.agent_name),
    String(row.session_id),
  ]);
  db.function("codesesh_message_matches_terms", { deterministic: true }, (text) =>
    textMatchesTerms(String(text ?? ""), terms) ? 1 : 0,
  );

  const messageRows = db
    .prepare(
      `
        WITH candidate_sessions(agent_name, session_id) AS (
          VALUES ${candidateValues}
        ),
        first_message_matches AS MATERIALIZED (
          SELECT
            c.agent_name,
            c.session_id,
            (
              SELECT m.rowid
              FROM messages m INDEXED BY idx_messages_session
              WHERE m.agent_name = c.agent_name
                AND m.session_id = c.session_id
                AND codesesh_message_matches_terms(m.content_text)
              ORDER BY m.message_index
              LIMIT 1
            ) AS message_rowid
          FROM candidate_sessions c
        )
        SELECT
          m.agent_name,
          m.session_id,
          m.message_index,
          m.role,
          m.mode,
          m.content_text,
          m.tool_metadata_json
        FROM first_message_matches f
        JOIN messages m ON m.rowid = f.message_rowid
      `,
    )
    .all(...candidateParams) as MessageSearchRow[];
  const matches = new Map<string, SearchSnippet & { matchType: SearchMatchType }>();

  for (const message of messageRows) {
    const key = searchResultRowKey(message);
    if (matches.has(key)) continue;

    const text = String(message.content_text ?? "");
    if (!textMatchesTerms(text, terms)) continue;

    matches.set(key, {
      ...buildTermSnippet(text, terms),
      matchType: messageMatchType(message),
    });
  }

  return matches;
}

function resolveSearchMatch(
  row: SearchResultRow,
  terms: { terms: string[]; mode: "all" | "any" },
  messageMatches: Map<string, SearchSnippet & { matchType: SearchMatchType }>,
): SearchSnippet & { matchType: SearchMatchType } {
  const title = String(row.title ?? "");

  if (terms.terms.length === 0) {
    return {
      snippet: `Recent session · ${String(row.directory ?? "")}`,
      snippetHighlights: [],
      matchType: "recent",
    };
  }

  if (textMatchesTerms(title, terms)) {
    return { ...buildTermSnippet(title, terms), matchType: "title" };
  }

  const messageMatch = messageMatches.get(searchResultRowKey(row));
  if (messageMatch) {
    return messageMatch;
  }

  return {
    snippet: String(row.snippet ?? ""),
    snippetHighlights: findHighlightRanges(String(row.snippet ?? ""), terms.terms),
    matchType: "assistant_reply",
  };
}

function rowsToSearchResults(
  db: SQLiteDatabase,
  rows: SearchResultRow[],
  textQuery: string,
): SearchResult[] {
  const terms = parseTextTerms(textQuery);
  const messageMatches =
    terms.terms.length > 0
      ? fetchMessageSearchMatches(db, rows, terms)
      : new Map<string, SearchSnippet & { matchType: SearchMatchType }>();

  return rows.map((row) => {
    const match = resolveSearchMatch(row, terms, messageMatches);
    return {
      reference: {
        agentName: String(row.agent_name),
        sessionId: String(row.session_id),
      },
      session: sessionHeadFromSearchRow(row),
      snippet: match.snippet,
      snippetHighlights: match.snippetHighlights,
      matchType: match.matchType,
    };
  });
}

export function searchSessions(query: string, options: SearchOptions = {}): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const normalizedQuery = search.text.trim();
  if (!hasCacheStorage()) {
    return [];
  }

  const results = withSearchDb((db) => {
    const filters = buildSessionSearchFilters(search.options);

    if (!normalizedQuery) {
      const rows = db
        .prepare(
          `
            SELECT
              ${searchSessionColumns()},
              '' AS snippet
            FROM sessions s
            WHERE 1 = 1
              AND s.publication_id IS NULL
              ${filters.where}
            ORDER BY s.activity_time DESC
            LIMIT ?
          `,
        )
        .all(...filters.params, search.options.limit ?? 50) as SearchResultRow[];

      return rowsToSearchResults(db, rows, "");
    }

    const ftsQuery = toFtsQuery(normalizedQuery);
    if (!ftsQuery) return [];
    const rows = db
      .prepare(
        `
          SELECT
            ${searchSessionColumns()},
            COALESCE(
              NULLIF(snippet(session_documents_fts, 1, '', '', ' … ', 18), ''),
              highlight(session_documents_fts, 0, '', '')
            ) AS snippet
          FROM session_documents_fts
          JOIN session_documents d ON d.id = session_documents_fts.rowid
          JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id
          WHERE session_documents_fts MATCH ?
            AND s.publication_id IS NULL
            ${filters.where}
          ORDER BY bm25(session_documents_fts, 8.0, 1.0), s.activity_time DESC
          LIMIT ?
        `,
      )
      .all(ftsQuery, ...filters.params, search.options.limit ?? 50) as SearchResultRow[];

    return rowsToSearchResults(db, rows, normalizedQuery);
  });

  return results ?? [];
}
