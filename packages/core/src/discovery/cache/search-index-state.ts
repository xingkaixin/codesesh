import type { SessionCacheMeta } from "../../agents/session-source-types.js";
import type { SessionHead } from "../../types/index.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { withCacheDbReadOnly } from "./connection.js";
import { sessionDetailVersion } from "./detail-version.js";
import type { SessionSnapshotCompleteness } from "./snapshot-types.js";

export type SearchIndexPublicationStage =
  | "started"
  | "prepared"
  | "cache_staged"
  | "search_staged"
  | "committed";

export interface SearchIndexSyncOptions {
  isBulk?: boolean;
  bulkThreshold?: number;
  includePendingReindex?: boolean;
  detailVersions?: Readonly<Record<string, string>>;
  completeness?: SessionSnapshotCompleteness;
  removedSessionIds?: readonly string[];
  publicationId?: string;
  onPublicationStage?: (stage: SearchIndexPublicationStage) => void;
}

export interface PendingSearchIndexMaintenance {
  sessionIds: string[];
  total: number;
}

export interface SearchIndexState {
  contentHashBySessionId: Map<string, string>;
  publishedContentHashBySessionId: Map<string, string>;
  publishedDetailFactsHashBySessionId: Map<string, string>;
  indexedMessageCountBySessionId: Map<string, number>;
  messageCountBySessionId: Map<string, number>;
  detailVersionBySessionId: Map<string, string>;
  targetDetailVersionBySessionId: Map<string, string>;
  pendingReindexSessionIds: Set<string>;
}

interface IndexedSearchRow {
  session_id?: string;
  content_hash?: string;
  indexed_message_count?: number;
  detail_version?: string;
  meta_json?: string | null;
}

interface PublishedSessionRow {
  session_title?: string | null;
  session_directory?: string | null;
  session_time_created?: number | null;
  session_time_updated?: number | null;
  session_message_count?: number | null;
  session_total_input_tokens?: number | null;
  session_total_output_tokens?: number | null;
  session_total_cache_read_tokens?: number | null;
  session_total_cache_create_tokens?: number | null;
  session_total_cost?: number | null;
  session_cost_source?: string | null;
  session_total_tokens?: number | null;
  session_project_identity_kind?: string | null;
  session_project_identity_key?: string | null;
  session_project_display_name?: string | null;
  session_project_identity_resolver_revision?: string | null;
  session_project_identity_input_signature?: string | null;
}

interface MessageCountRow {
  session_id?: string;
  value?: number;
}

type SearchIndexStateRow = IndexedSearchRow & MessageCountRow & PublishedSessionRow;

interface SearchIndexSessionFacts {
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalCost: number;
  costSource: string;
  totalTokens: number;
  projectIdentityKind: string;
  projectIdentityKey: string;
  projectDisplayName: string;
  projectIdentityResolverRevision: string;
  projectIdentityInputSignature: string;
}

type SearchIndexDetailFacts = Pick<
  SearchIndexSessionFacts,
  | "timeCreated"
  | "timeUpdated"
  | "messageCount"
  | "totalInputTokens"
  | "totalOutputTokens"
  | "totalCacheReadTokens"
  | "totalCacheCreateTokens"
  | "totalCost"
  | "costSource"
  | "totalTokens"
>;

const SEARCH_INDEX_STATE_BATCH_SIZE = 900;

function readPendingReindexIds(db: SQLiteDatabase, agentName: string): Set<string> {
  const rows = db
    .prepare("SELECT session_id FROM pending_reindex WHERE agent_name = ?")
    .all(agentName) as Array<{ session_id?: string }>;
  return new Set(rows.map((row) => String(row.session_id)));
}

function searchIndexSessionFacts(session: SessionHead): SearchIndexSessionFacts {
  return {
    title: session.title,
    directory: session.directory,
    timeCreated: session.time_created,
    timeUpdated: session.time_updated ?? session.time_created,
    messageCount: session.stats.message_count,
    totalInputTokens: session.stats.total_input_tokens,
    totalOutputTokens: session.stats.total_output_tokens,
    totalCacheReadTokens: session.stats.total_cache_read_tokens ?? 0,
    totalCacheCreateTokens: session.stats.total_cache_create_tokens ?? 0,
    totalCost: session.stats.total_cost,
    costSource: session.stats.cost_source ?? "",
    totalTokens: session.stats.total_tokens ?? 0,
    projectIdentityKind: session.project_identity?.kind ?? "",
    projectIdentityKey: session.project_identity?.key ?? "",
    projectDisplayName: session.project_identity?.displayName ?? "",
    projectIdentityResolverRevision: session.project_identity_resolver_revision ?? "",
    projectIdentityInputSignature: session.project_identity_input_signature ?? "",
  };
}

function hashSearchIndexSessionFacts(facts: SearchIndexSessionFacts): string {
  return JSON.stringify(facts);
}

function searchIndexDetailFacts(facts: SearchIndexSessionFacts): SearchIndexDetailFacts {
  return {
    timeCreated: facts.timeCreated,
    timeUpdated: facts.timeUpdated,
    messageCount: facts.messageCount,
    totalInputTokens: facts.totalInputTokens,
    totalOutputTokens: facts.totalOutputTokens,
    totalCacheReadTokens: facts.totalCacheReadTokens,
    totalCacheCreateTokens: facts.totalCacheCreateTokens,
    totalCost: facts.totalCost,
    costSource: facts.costSource,
    totalTokens: facts.totalTokens,
  };
}

function hashSearchIndexDetailFacts(facts: SearchIndexSessionFacts): string {
  return JSON.stringify(searchIndexDetailFacts(facts));
}

export function sessionContentHash(session: SessionHead): string {
  return hashSearchIndexSessionFacts(searchIndexSessionFacts(session));
}

function publishedSessionContentHash(row: PublishedSessionRow): string | null {
  if (row.session_title == null) return null;
  return hashSearchIndexSessionFacts(searchIndexSessionFactsFromRow(row));
}

function publishedSessionDetailFactsHash(row: PublishedSessionRow): string | null {
  if (row.session_title == null) return null;
  return hashSearchIndexDetailFacts(searchIndexSessionFactsFromRow(row));
}

function searchIndexSessionFactsFromRow(row: PublishedSessionRow): SearchIndexSessionFacts {
  return {
    title: String(row.session_title),
    directory: row.session_directory ?? "",
    timeCreated: Number(row.session_time_created ?? 0),
    timeUpdated: Number(row.session_time_updated ?? row.session_time_created ?? 0),
    messageCount: Number(row.session_message_count ?? 0),
    totalInputTokens: Number(row.session_total_input_tokens ?? 0),
    totalOutputTokens: Number(row.session_total_output_tokens ?? 0),
    totalCacheReadTokens: Number(row.session_total_cache_read_tokens ?? 0),
    totalCacheCreateTokens: Number(row.session_total_cache_create_tokens ?? 0),
    totalCost: Number(row.session_total_cost ?? 0),
    costSource: row.session_cost_source ?? "",
    totalTokens: Number(row.session_total_tokens ?? 0),
    projectIdentityKind: row.session_project_identity_kind ?? "",
    projectIdentityKey: row.session_project_identity_key ?? "",
    projectDisplayName: row.session_project_display_name ?? "",
    projectIdentityResolverRevision: row.session_project_identity_resolver_revision ?? "",
    projectIdentityInputSignature: row.session_project_identity_input_signature ?? "",
  };
}

export function sessionDetailFactsHash(session: SessionHead): string {
  return hashSearchIndexDetailFacts(searchIndexSessionFacts(session));
}

export function detailVersionFromMetaJson(value: string | null | undefined): string {
  if (!value) return sessionDetailVersion(null);
  try {
    return sessionDetailVersion(JSON.parse(value) as SessionCacheMeta);
  } catch {
    return sessionDetailVersion(null);
  }
}

function searchIndexStateFromRows(
  indexedRows: SearchIndexStateRow[],
  messageCountRows: MessageCountRow[],
  pendingReindexSessionIds: Set<string> = new Set(),
): SearchIndexState {
  return {
    contentHashBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
    ),
    publishedContentHashBySessionId: new Map(
      indexedRows.flatMap((row) => {
        const contentHash = publishedSessionContentHash(row);
        return contentHash == null ? [] : [[String(row.session_id), contentHash]];
      }),
    ),
    publishedDetailFactsHashBySessionId: new Map(
      indexedRows.flatMap((row) => {
        const detailFactsHash = publishedSessionDetailFactsHash(row);
        return detailFactsHash == null ? [] : [[String(row.session_id), detailFactsHash]];
      }),
    ),
    indexedMessageCountBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), Number(row.indexed_message_count ?? 0)]),
    ),
    messageCountBySessionId: new Map(
      messageCountRows.map((row) => [String(row.session_id), Number(row.value ?? 0)]),
    ),
    detailVersionBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.detail_version ?? "")]),
    ),
    targetDetailVersionBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), detailVersionFromMetaJson(row.meta_json)]),
    ),
    pendingReindexSessionIds,
  };
}

/**
 * Freshness probe for a batch of sessions: is each one's indexed document still
 * in step with its cached head?
 *
 * INDEXED BY is not a micro-optimisation. Without stats SQLite prefers the
 * UNIQUE(agent_name, session_id) auto-index, and reaching content_hash then
 * means reading each row past content_text through its overflow chain — proving
 * an unchanged agent is up to date would cost the size of the indexed corpus.
 * Pinning the covering index keeps the probe proportional to the session count.
 */
export function searchIndexStateQuery(sessionIdCount: number): string {
  const requestedRows = Array.from({ length: sessionIdCount }, () => "(?)").join(", ");
  return `
    WITH requested_session_ids(session_id) AS (VALUES ${requestedRows})
    SELECT
      requested.session_id,
      documents.content_hash,
      documents.indexed_message_count,
      documents.detail_version,
      sessions.meta_json,
      sessions.title AS session_title,
      sessions.directory AS session_directory,
      sessions.time_created AS session_time_created,
      sessions.time_updated AS session_time_updated,
      sessions.message_count AS session_message_count,
      sessions.total_input_tokens AS session_total_input_tokens,
      sessions.total_output_tokens AS session_total_output_tokens,
      sessions.total_cache_read_tokens AS session_total_cache_read_tokens,
      sessions.total_cache_create_tokens AS session_total_cache_create_tokens,
      sessions.total_cost AS session_total_cost,
      sessions.cost_source AS session_cost_source,
      sessions.total_tokens AS session_total_tokens,
      sessions.project_identity_kind AS session_project_identity_kind,
      sessions.project_identity_key AS session_project_identity_key,
      sessions.project_display_name AS session_project_display_name,
      sessions.project_identity_resolver_revision AS session_project_identity_resolver_revision,
      sessions.project_identity_input_signature AS session_project_identity_input_signature,
      (
        SELECT COUNT(*)
        FROM messages
        WHERE messages.agent_name = ?
          AND messages.session_id = requested.session_id
      ) AS value
    FROM requested_session_ids AS requested
    LEFT JOIN session_documents AS documents
      INDEXED BY idx_session_documents_state
      ON documents.agent_name = ? AND documents.session_id = requested.session_id
    LEFT JOIN sessions
      ON sessions.agent_name = ? AND sessions.session_id = requested.session_id
  `;
}

export function readSearchIndexState(
  db: SQLiteDatabase,
  agentName: string,
  sessionIds: string[],
): SearchIndexState {
  const rows: SearchIndexStateRow[] = [];
  const uniqueSessionIds = [...new Set(sessionIds)];

  for (let offset = 0; offset < uniqueSessionIds.length; offset += SEARCH_INDEX_STATE_BATCH_SIZE) {
    const batch = uniqueSessionIds.slice(offset, offset + SEARCH_INDEX_STATE_BATCH_SIZE);
    const batchRows = db
      .prepare(searchIndexStateQuery(batch.length))
      .all(...batch, agentName, agentName, agentName) as SearchIndexStateRow[];
    rows.push(...batchRows);
  }

  return searchIndexStateFromRows(rows, rows, readPendingReindexIds(db, agentName));
}

export function targetDetailVersion(
  state: SearchIndexState,
  sessionId: string,
  options: SearchIndexSyncOptions,
): string {
  return (
    options.detailVersions?.[sessionId] ??
    state.targetDetailVersionBySessionId.get(sessionId) ??
    sessionDetailVersion(null)
  );
}

export function searchIndexEntryNeedsUpdate(
  state: SearchIndexState,
  session: SessionHead,
  options: SearchIndexSyncOptions,
): boolean {
  const sessionId = session.reference.sessionId;
  const pendingMaintenance = state.pendingReindexSessionIds.has(sessionId);
  const targetVersion = targetDetailVersion(state, sessionId, options);
  if (pendingMaintenance && options.includePendingReindex === false) {
    return (
      state.publishedContentHashBySessionId.get(sessionId) !== sessionContentHash(session) ||
      state.targetDetailVersionBySessionId.get(sessionId) !== targetVersion
    );
  }
  return (
    pendingMaintenance ||
    state.detailVersionBySessionId.get(sessionId) !== targetVersion ||
    state.contentHashBySessionId.get(sessionId) !== sessionContentHash(session) ||
    state.indexedMessageCountBySessionId.get(sessionId) !==
      (state.messageCountBySessionId.get(sessionId) ?? 0)
  );
}

export function readPendingSearchIndexMaintenance(
  agentName: string,
  limit: number,
): PendingSearchIndexMaintenance | null {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const outcome = withCacheDbReadOnly((db) => {
    const totalRow = db
      .prepare(
        `
          SELECT COUNT(*) AS value
          FROM pending_reindex AS pending
          INNER JOIN sessions
            ON sessions.agent_name = pending.agent_name
            AND sessions.session_id = pending.session_id
          WHERE pending.agent_name = ?
            AND sessions.publication_id IS NULL
        `,
      )
      .get(agentName) as { value?: number } | undefined;
    const rows = db
      .prepare(
        `
          SELECT pending.session_id
          FROM pending_reindex AS pending
          INNER JOIN sessions
            ON sessions.agent_name = pending.agent_name
            AND sessions.session_id = pending.session_id
          WHERE pending.agent_name = ?
            AND sessions.publication_id IS NULL
          ORDER BY sessions.sort_index, pending.session_id
          LIMIT ?
        `,
      )
      .all(agentName, boundedLimit) as Array<{ session_id?: string }>;
    return {
      sessionIds: rows.map((row) => String(row.session_id)),
      total: Number(totalRow?.value ?? 0),
    };
  });
  return outcome.status === "success" ? outcome.value : null;
}
