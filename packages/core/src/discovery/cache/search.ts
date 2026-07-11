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
import type { SearchMatchType, SearchResult } from "../../contract/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import { escapeRegExp, filePathFtsQuery, hasCacheStorage, likePattern } from "./db.js";
import { normalizeToolName, sessionFromRow, type SessionRow } from "./messages.js";
import { ensureFtsReady, withCacheDb } from "./schema.js";
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
  cwd?: string;
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

export {
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type SearchIndexSyncOptions,
  type SearchIndexSyncResult,
} from "./search-index-writer.js";

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
      cwd: options.cwd ?? parsed.filters.cwd,
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

export function sessionMatchesSearchCost(session: SessionHead, options: SearchOptions): boolean {
  const cost = session.stats.total_cost;
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

function buildSessionSearchFilters(options: SearchOptions): {
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
  if (options.cwd) {
    const identity = computeIdentity(options.cwd, realFs);
    clauses.push(
      "((s.project_identity_kind = ? AND s.project_identity_key = ?) OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    params.push(identity.kind, identity.key, likePattern(options.cwd));
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
  if (options.costMin != null) {
    clauses.push(options.costMinExclusive ? "s.total_cost > ?" : "s.total_cost >= ?");
    params.push(options.costMin);
  }
  if (options.costMax != null) {
    clauses.push(options.costMaxExclusive ? "s.total_cost < ?" : "s.total_cost <= ?");
    params.push(options.costMax);
  }

  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params,
  };
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

function highlightTerm(text: string, term: string): string {
  return text.replace(new RegExp(escapeRegExp(term), "gi"), (match) => `<mark>${match}</mark>`);
}

function buildTermSnippet(text: string, terms: { terms: string[]; mode: "all" | "any" }): string {
  const lower = text.toLowerCase();
  const term = terms.terms.find((item) => lower.includes(item)) ?? terms.terms[0] ?? "";
  if (!term) return text.slice(0, 180);

  const index = lower.indexOf(term);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "… " : ""}${highlightTerm(text.slice(start, end), term)}${
    end < text.length ? " …" : ""
  }`;
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
  ftsQuery: string,
  terms: { terms: string[]; mode: "all" | "any" },
): Map<string, { snippet: string; matchType: SearchMatchType }> {
  const candidates = rows.filter((row) => !textMatchesTerms(String(row.title ?? ""), terms));
  if (candidates.length === 0) {
    return new Map();
  }

  const clauses: string[] = [];
  const params: unknown[] = [ftsQuery];
  for (const row of candidates) {
    clauses.push("(m.agent_name = ? AND m.session_id = ?)");
    params.push(String(row.agent_name), String(row.session_id));
  }

  const messageRows = db
    .prepare(
      `
        SELECT
          m.agent_name,
          m.session_id,
          m.message_index,
          m.role,
          m.mode,
          m.content_text,
          m.tool_metadata_json
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND (${clauses.join(" OR ")})
        ORDER BY m.message_index
      `,
    )
    .all(...params) as MessageSearchRow[];
  const matches = new Map<string, { snippet: string; matchType: SearchMatchType }>();

  for (const message of messageRows) {
    const key = searchResultRowKey(message);
    if (matches.has(key)) continue;

    const text = String(message.content_text ?? "");
    if (!textMatchesTerms(text, terms)) continue;

    matches.set(key, {
      snippet: buildTermSnippet(text, terms),
      matchType: messageMatchType(message),
    });
  }

  return matches;
}

function resolveSearchMatch(
  row: SearchResultRow,
  terms: { terms: string[]; mode: "all" | "any" },
  messageMatches: Map<string, { snippet: string; matchType: SearchMatchType }>,
): { snippet: string; matchType: SearchMatchType } {
  const title = String(row.title ?? "");

  if (terms.terms.length === 0) {
    return {
      snippet: `Recent session · ${String(row.directory ?? "")}`,
      matchType: "recent",
    };
  }

  if (textMatchesTerms(title, terms)) {
    return { snippet: buildTermSnippet(title, terms), matchType: "title" };
  }

  const messageMatch = messageMatches.get(searchResultRowKey(row));
  if (messageMatch) {
    return messageMatch;
  }

  return {
    snippet: String(row.snippet ?? ""),
    matchType: "assistant_reply",
  };
}

function rowsToSearchResults(
  db: SQLiteDatabase,
  rows: SearchResultRow[],
  textQuery: string,
  ftsQuery = toFtsQuery(textQuery),
): SearchResult[] {
  const terms = parseTextTerms(textQuery);
  const messageMatches =
    terms.terms.length > 0 && ftsQuery
      ? fetchMessageSearchMatches(db, rows, ftsQuery, terms)
      : new Map<string, { snippet: string; matchType: SearchMatchType }>();

  return rows.map((row) => {
    const match = resolveSearchMatch(row, terms, messageMatches);
    return {
      agentName: String(row.agent_name),
      session: sessionHeadFromSearchRow(row),
      snippet: match.snippet,
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

  const results = withCacheDb((db) => {
    ensureFtsReady(db);
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
              NULLIF(snippet(session_documents_fts, 1, '<mark>', '</mark>', ' … ', 18), ''),
              highlight(session_documents_fts, 0, '<mark>', '</mark>')
            ) AS snippet
          FROM session_documents_fts
          JOIN session_documents d ON d.id = session_documents_fts.rowid
          JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id
          WHERE session_documents_fts MATCH ?
            ${filters.where}
          ORDER BY bm25(session_documents_fts, 8.0, 1.0), s.activity_time DESC
          LIMIT ?
        `,
      )
      .all(ftsQuery, ...filters.params, search.options.limit ?? 50) as SearchResultRow[];

    return rowsToSearchResults(db, rows, normalizedQuery, ftsQuery);
  });

  return results ?? [];
}
