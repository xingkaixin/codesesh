import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";

interface StagedPublicationRow extends DatabaseRow {
  session_id?: string;
  payload_json?: string;
}

const PUBLICATION_READ_BATCH_SIZE = 64;

export interface PublicationPayload {
  sessionId: string;
  json: string;
}

export function createPublicationStagingTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index_publication_entries (
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
  const upsert = db.prepare(`
    INSERT INTO search_index_publication_entries(
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

export function* readPublicationPayloads(
  db: SQLiteDatabase,
  publicationId: string,
  agentName: string,
): Generator<string> {
  const readBatch = db.prepare(`
        SELECT session_id, payload_json
        FROM search_index_publication_entries
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

export function deletePublicationPayloads(db: SQLiteDatabase, publicationId: string): void {
  db.prepare("DELETE FROM search_index_publication_entries WHERE publication_id = ?").run(
    publicationId,
  );
}

function deleteLegacyPublicationRows(db: SQLiteDatabase, publicationId?: string): void {
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

export function discardPublicationStaging(db: SQLiteDatabase, publicationId?: string): void {
  deleteLegacyPublicationRows(db, publicationId);
  if (publicationId) {
    deletePublicationPayloads(db, publicationId);
  } else {
    db.prepare("DELETE FROM search_index_publication_entries").run();
  }
}
