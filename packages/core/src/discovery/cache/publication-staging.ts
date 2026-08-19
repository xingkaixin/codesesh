import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";

interface StagedPublicationRow extends DatabaseRow {
  session_id?: string;
  payload_json?: string;
}

const PUBLICATION_READ_BATCH_SIZE = 64;
const STAGING_TABLE = "temp.search_index_publication_entries";

export interface PublicationPayload {
  sessionId: string;
  json: string;
}

/**
 * Staged payloads are scratch for one in-process publication — nothing resumes
 * one across processes. Holding them in the connection's TEMP schema makes an
 * orphan unrepresentable: an abrupt exit returns the bytes to the OS instead of
 * leaving a corpus-sized copy inside the durable cache for a sweeper to find.
 */
function ensureStagingTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS search_index_publication_entries (
      publication_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (publication_id, agent_name, session_id)
    );
  `);
}

export function stagePublicationPayloads(
  db: SQLiteDatabase,
  publicationId: string,
  agentName: string,
  payloads: Iterable<PublicationPayload>,
): number {
  ensureStagingTable(db);
  const upsert = db.prepare(`
    INSERT INTO ${STAGING_TABLE}(
      publication_id,
      agent_name,
      session_id,
      payload_json
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(publication_id, agent_name, session_id) DO UPDATE SET
      payload_json = excluded.payload_json
  `);
  let staged = 0;
  for (const payload of payloads) {
    upsert.run(publicationId, agentName, payload.sessionId, payload.json);
    staged += 1;
  }
  return staged;
}

/**
 * Deliberately does not create the table: staging and commit must share one
 * connection, so a missing temp schema means that invariant broke and must fail
 * loudly instead of silently indexing nothing.
 */
export function* readPublicationPayloads(
  db: SQLiteDatabase,
  publicationId: string,
  agentName: string,
): Generator<string> {
  const readBatch = db.prepare(`
        SELECT session_id, payload_json
        FROM ${STAGING_TABLE}
        WHERE publication_id = ? AND agent_name = ? AND session_id > ?
        ORDER BY session_id
        LIMIT ?
      `);
  let cursor = "";
  while (true) {
    const rows = readBatch.all(
      publicationId,
      agentName,
      cursor,
      PUBLICATION_READ_BATCH_SIZE,
    ) as StagedPublicationRow[];
    if (rows.length === 0) return;
    for (const row of rows) yield String(row.payload_json ?? "");
    cursor = String(rows.at(-1)?.session_id ?? "");
  }
}

export function deletePublicationPayloads(
  db: SQLiteDatabase,
  publicationId: string,
  agentName: string,
): void {
  ensureStagingTable(db);
  db.prepare(`DELETE FROM ${STAGING_TABLE} WHERE publication_id = ? AND agent_name = ?`).run(
    publicationId,
    agentName,
  );
}

export function hasLegacyPublicationRows(db: SQLiteDatabase, publicationId?: string): boolean {
  const predicate = publicationId ? "publication_id = ?" : "publication_id IS NOT NULL";
  const params = publicationId ? [publicationId] : [];
  return (
    db.prepare(`SELECT 1 FROM sessions WHERE ${predicate} LIMIT 1`).get(...params) !== undefined
  );
}

export function deleteLegacyPublicationRows(db: SQLiteDatabase, publicationId?: string): void {
  // Schema v21 could leave staged heads and their live detail rows after an interruption.
  const predicate = publicationId
    ? "staged.publication_id = ?"
    : "staged.publication_id IS NOT NULL";
  const params = publicationId ? [publicationId] : [];
  for (const [table, alias] of [
    ["message_tools", "target"],
    ["messages", "target"],
    ["session_file_activity", "target"],
    ["session_documents", "target"],
    ["pending_reindex", "target"],
  ] as const) {
    db.prepare(`
      DELETE FROM ${table} AS ${alias}
      WHERE EXISTS (
        SELECT 1
        FROM sessions AS staged
        WHERE staged.agent_name = ${alias}.agent_name
          AND staged.session_id = ${alias}.session_id
          AND ${predicate}
      )
    `).run(...params);
  }
  db.prepare(
    publicationId
      ? "DELETE FROM sessions WHERE publication_id = ?"
      : "DELETE FROM sessions WHERE publication_id IS NOT NULL",
  ).run(...params);
}

export function discardPublicationStaging(
  db: SQLiteDatabase,
  publicationId: string,
  agentName: string,
): void {
  if (hasLegacyPublicationRows(db, publicationId)) {
    deleteLegacyPublicationRows(db, publicationId);
  }
  deletePublicationPayloads(db, publicationId, agentName);
}
