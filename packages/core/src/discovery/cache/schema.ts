/** Cache schema creation, migration, and search-index repair. */
import type { ProjectIdentityKind, SessionHead } from "../../types/index.js";
import { createSessionIdentity } from "../../contract/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import {
  columnExists,
  getUserVersion,
  runSchemaMigrations,
  setUserVersion,
  tableExists,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../../utils/sqlite.js";
import { runCacheContentMigrations } from "./content-migrations.js";
import { type CacheRow } from "./db.js";
import {
  messageFromBackfillRow,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertSession,
  sourcePathFromMetaJson,
  toolNamesFromMetadataJson,
  upsertSessionRow,
  writeFileActivityRows,
  type MessageBackfillRow,
  type SessionRow,
} from "./messages.js";
import {
  addDetailVersion,
  addIndexedMessageCount,
  addProjectIdentityProvenance,
  addSessionPublicationId,
  createCacheMetadataTables,
  createLegacyCacheTables,
  createFileActivityPathSearchTables,
  createFileActivityTables,
  createMessageToolTables,
  createLegacyProjectTables,
  createSearchStateIndex,
  createSearchTables,
  createSessionTables,
  createSessionModelCostTable,
  dropLegacyMessageSearchIndex,
  dropSearchTriggers,
  ensureLegacySessionDocumentColumns,
  rebuildFileActivityPathIndex,
  recreateProjectGroupsView,
} from "./schema-definitions.js";
import { ensureFtsReady, rebuildSearchIndex } from "./schema-fts.js";
import {
  getCurrentCacheSchemaVersion,
  hasAnyCacheSchema,
  prepareLegacyProjectIdentityResolver,
  readLegacyCacheVersion,
  type LegacyProjectIdentityResolver,
  type ProjectBackfillSessionRow,
} from "./schema-version.js";
import { CACHE_SCHEMA_VERSION } from "./version.js";
import { UnsupportedCacheSchemaVersionError } from "./errors.js";

export { runSearchIndexWrite, runWithFtsRecovery } from "./schema-fts.js";

interface MessageToolBackfillRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  message_index?: number;
  tool_metadata_json?: string | null;
}

interface ProjectBackfillDocumentRow extends DatabaseRow {
  id?: number;
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
  activity_time?: number;
}

interface ProjectIdentityRefreshRow extends DatabaseRow {
  id?: number;
  agent_name?: string;
  session_id?: string;
  directory?: string;
}

function getLegacySessionDirectory(session: SessionHead): string | null {
  return typeof session.directory === "string" ? session.directory : null;
}

function removeLegacySessionIdentityFields(session: SessionHead): SessionHead {
  const normalized = { ...session } as SessionHead & { id?: unknown; slug?: unknown };
  delete normalized.id;
  delete normalized.slug;
  return normalized;
}

function createLatestCacheSchema(db: SQLiteDatabase): void {
  createCacheMetadataTables(db);
  createSessionTables(db);
  createFileActivityTables(db);
  recreateProjectGroupsView(db);
  ensureFtsReady(db);
}

function recreateSearchIndexSchema(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
    DROP TABLE IF EXISTS session_documents_fts;
  `);
  createSearchTables(db);
  rebuildSearchIndex(db);
}

function backfillProjectSessions(
  db: SQLiteDatabase,
  resolveIdentity: LegacyProjectIdentityResolver,
): void {
  if (!tableExists(db, "cached_sessions") || !tableExists(db, "project_sessions")) {
    return;
  }

  const rows = db
    .prepare("SELECT agent_name, session_id, session_json FROM cached_sessions")
    .all() as ProjectBackfillSessionRow[];
  const upsert = db.prepare(`
    INSERT INTO project_sessions(
      agent_name,
      session_id,
      identity_kind,
      identity_key,
      display_name,
      directory,
      activity_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      identity_kind = excluded.identity_kind,
      identity_key = excluded.identity_key,
      display_name = excluded.display_name,
      directory = excluded.directory,
      activity_time = excluded.activity_time
  `);

  for (const row of rows) {
    if (!row.session_json || !row.agent_name || !row.session_id) {
      continue;
    }

    try {
      const session = JSON.parse(row.session_json) as SessionHead;
      const directory = getLegacySessionDirectory(session);
      if (directory == null) continue;
      const identity = session.project_identity ?? resolveIdentity(directory);
      upsert.run(
        row.agent_name,
        row.session_id,
        identity.kind,
        identity.key,
        identity.displayName,
        directory,
        session.time_updated ?? session.time_created,
      );
    } catch {
      continue;
    }
  }
}

function backfillSessionDocumentProjects(
  db: SQLiteDatabase,
  resolveIdentity: LegacyProjectIdentityResolver,
): void {
  if (
    !tableExists(db, "session_documents") ||
    !columnExists(db, "session_documents", "project_identity_key")
  ) {
    return;
  }

  const rows = db
    .prepare("SELECT id, directory FROM session_documents")
    .all() as ProjectBackfillDocumentRow[];
  const update = db.prepare(`
    UPDATE session_documents
    SET
      project_identity_kind = ?,
      project_identity_key = ?,
      project_display_name = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const identity = resolveIdentity(String(row.directory ?? ""));
    update.run(identity.kind, identity.key, identity.displayName, Number(row.id));
  }
}

function migrateProjectIdentity(
  db: SQLiteDatabase,
  resolveIdentity: LegacyProjectIdentityResolver,
): void {
  ensureLegacySessionDocumentColumns(db);
  createLegacyProjectTables(db);
  backfillProjectSessions(db, resolveIdentity);
  backfillSessionDocumentProjects(db, resolveIdentity);
}

function refreshProjectIdentities(
  db: SQLiteDatabase,
  resolveIdentity: LegacyProjectIdentityResolver,
): void {
  if (
    tableExists(db, "sessions") &&
    columnExists(db, "sessions", "project_identity_key") &&
    columnExists(db, "sessions", "directory")
  ) {
    const rows = db
      .prepare("SELECT agent_name, session_id, directory FROM sessions")
      .all() as ProjectIdentityRefreshRow[];
    const update = db.prepare(`
      UPDATE sessions
      SET
        project_identity_kind = ?,
        project_identity_key = ?,
        project_display_name = ?
      WHERE agent_name = ? AND session_id = ?
    `);
    const updateFileActivity =
      tableExists(db, "session_file_activity") &&
      columnExists(db, "session_file_activity", "project_identity_key")
        ? db.prepare(`
            UPDATE session_file_activity
            SET project_identity_key = ?
            WHERE agent_name = ? AND session_id = ?
          `)
        : null;

    for (const row of rows) {
      const identity = resolveIdentity(String(row.directory ?? ""));
      update.run(identity.kind, identity.key, identity.displayName, row.agent_name, row.session_id);
      updateFileActivity?.run(identity.key, row.agent_name, row.session_id);
    }
  }

  if (
    tableExists(db, "project_sessions") &&
    columnExists(db, "project_sessions", "identity_key") &&
    columnExists(db, "project_sessions", "directory")
  ) {
    const rows = db
      .prepare("SELECT agent_name, session_id, directory FROM project_sessions")
      .all() as ProjectIdentityRefreshRow[];
    const update = db.prepare(`
      UPDATE project_sessions
      SET
        identity_kind = ?,
        identity_key = ?,
        display_name = ?
      WHERE agent_name = ? AND session_id = ?
    `);

    for (const row of rows) {
      const identity = resolveIdentity(String(row.directory ?? ""));
      update.run(identity.kind, identity.key, identity.displayName, row.agent_name, row.session_id);
    }
  }

  backfillSessionDocumentProjects(db, resolveIdentity);
  recreateProjectGroupsView(db);
}

function backfillStructuredSessions(
  db: SQLiteDatabase,
  resolveIdentity: LegacyProjectIdentityResolver,
): void {
  createSessionTables(db);
  recreateProjectGroupsView(db);
  const upsertSession = prepareUpsertSession(db);

  if (tableExists(db, "cached_sessions")) {
    const rows = db
      .prepare(
        "SELECT agent_name, session_id, session_json, meta_json, rowid AS sort_index FROM cached_sessions ORDER BY agent_name, rowid",
      )
      .all() as CacheRow[];

    for (const row of rows) {
      if (!row.agent_name || !row.session_json) {
        continue;
      }

      try {
        const parsed = JSON.parse(row.session_json) as SessionHead;
        const directory = getLegacySessionDirectory(parsed);
        if (directory == null) continue;
        const session = {
          ...removeLegacySessionIdentityFields(parsed),
          ...createSessionIdentity({
            agentName: String(row.agent_name),
            sessionId: String(row.session_id),
          }),
          project_identity: parsed.project_identity ?? resolveIdentity(directory),
        };
        upsertSessionRow(
          upsertSession,
          String(row.agent_name),
          session,
          row.meta_json ?? null,
          Number(row.sort_index ?? 0),
          sourcePathFromMetaJson(row.meta_json),
        );
      } catch {
        continue;
      }
    }
  }

  if (!tableExists(db, "session_documents")) {
    return;
  }

  const documentRows = db
    .prepare(
      `
        SELECT
          d.agent_name,
          d.session_id,
          d.slug,
          d.title,
          d.directory,
          d.project_identity_kind,
          d.project_identity_key,
          d.project_display_name,
          d.time_created,
          d.time_updated,
          d.activity_time,
          d.id
        FROM session_documents d
        LEFT JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id
        WHERE s.session_id IS NULL
        ORDER BY d.id
      `,
    )
    .all() as ProjectBackfillDocumentRow[];

  for (const row of documentRows) {
    const directory = String(row.directory ?? "");
    const identity =
      row.project_identity_key && row.project_identity_kind && row.project_display_name
        ? {
            kind: row.project_identity_kind,
            key: String(row.project_identity_key),
            displayName: String(row.project_display_name),
          }
        : resolveIdentity(directory);

    upsertSessionRow(
      upsertSession,
      String(row.agent_name),
      {
        ...createSessionIdentity({
          agentName: String(row.agent_name),
          sessionId: String(row.session_id),
        }),
        title: String(row.title),
        directory,
        project_identity: identity,
        time_created: Number(row.time_created ?? row.activity_time ?? 0),
        time_updated: row.time_updated == null ? undefined : Number(row.time_updated),
        stats: {
          message_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost: 0,
        },
      },
      null,
      Number(row.id ?? 0),
      null,
    );
  }
}

function backfillMessageTools(db: SQLiteDatabase): void {
  createMessageToolTables(db);
  if (!tableExists(db, "messages")) {
    return;
  }

  db.exec("DELETE FROM message_tools");
  const rows = db
    .prepare(
      `
        SELECT agent_name, session_id, message_index, tool_metadata_json
        FROM messages
        WHERE tool_metadata_json IS NOT NULL
      `,
    )
    .all() as MessageToolBackfillRow[];
  const insertTool = prepareInsertMessageTool(db);

  for (const row of rows) {
    if (!row.agent_name || !row.session_id || row.message_index == null) {
      continue;
    }

    for (const toolName of toolNamesFromMetadataJson(row.tool_metadata_json)) {
      insertTool.run(row.agent_name, row.session_id, row.message_index, toolName);
    }
  }
}

function backfillFileActivity(db: SQLiteDatabase): void {
  createFileActivityTables(db);
  if (!tableExists(db, "sessions") || !tableExists(db, "messages")) {
    return;
  }

  const sessions = db
    .prepare(
      `
        SELECT agent_name, session_id, project_identity_key
        FROM sessions
        ORDER BY agent_name, session_id
      `,
    )
    .all() as SessionRow[];
  const loadMessages = db.prepare(`
    SELECT
      message_id,
      role,
      time_created,
      time_completed,
      agent,
      mode,
      model,
      provider,
      parts_json,
      subagent_id,
      nickname
    FROM messages
    WHERE agent_name = ? AND session_id = ?
    ORDER BY message_index
  `);
  const deleteActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const insertActivity = prepareInsertFileActivity(db);

  for (const session of sessions) {
    if (!session.agent_name || !session.session_id || !session.project_identity_key) {
      continue;
    }

    try {
      const rows = loadMessages.all(session.agent_name, session.session_id) as MessageBackfillRow[];
      const messages = rows.map((row) => messageFromBackfillRow(row));
      const activities = extractSessionFileActivity(
        String(session.agent_name),
        String(session.session_id),
        String(session.project_identity_key),
        messages,
      );
      deleteActivity.run(session.agent_name, session.session_id);
      writeFileActivityRows(insertActivity, activities);
    } catch {
      continue;
    }
  }
}

function invalidateSearchContentHashes(db: SQLiteDatabase): void {
  if (
    tableExists(db, "session_documents") &&
    columnExists(db, "session_documents", "content_hash")
  ) {
    db.exec("UPDATE session_documents SET content_hash = ''");
  }
}

function addAtomicPublicationStaging(db: SQLiteDatabase): void {
  invalidateSearchContentHashes(db);
  if (tableExists(db, "sessions") && tableExists(db, "pending_reindex")) {
    db.exec(`
      INSERT OR IGNORE INTO pending_reindex(agent_name, session_id)
      SELECT agent_name, session_id
      FROM sessions
      WHERE publication_id IS NULL
    `);
  }
}

function dropDurablePublicationStaging(db: SQLiteDatabase): void {
  db.exec("DROP TABLE IF EXISTS search_index_publication_entries");
}

function replaceSessionActivityIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_agent_activity;
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity_order
      ON sessions(agent_name, activity_time DESC, session_id);
  `);
}

/**
 * The unfiltered "recent sessions" query orders by bare activity_time; every
 * existing index leads with agent_name, so the planner fell back to a full
 * scan plus a temp B-tree sort (verified via EXPLAIN QUERY PLAN, CS-271).
 */
function addSessionActivityIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_activity
      ON sessions(activity_time DESC, agent_name, session_id)
  `);
}

function addSessionModelCostRollup(db: SQLiteDatabase): void {
  createSessionModelCostTable(db);
  if (!tableExists(db, "messages")) return;
  db.exec(`
    INSERT OR REPLACE INTO session_model_cost(agent_name, session_id, model, cost, cost_recorded)
    SELECT
      agent_name,
      session_id,
      model,
      SUM(COALESCE(cost, 0)),
      SUM(CASE WHEN cost_source = 'recorded' THEN COALESCE(cost, 0) ELSE 0 END)
    FROM messages
    WHERE model IS NOT NULL AND model <> ''
    GROUP BY agent_name, session_id, model
  `);
}

function addSessionCostSummary(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_cost_summary (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_cost REAL NOT NULL,
      untimed_message_cost REAL NOT NULL,
      PRIMARY KEY (agent_name, session_id),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );
  `);
  if (!tableExists(db, "messages")) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_cost_time
      ON messages(
        CASE
          WHEN time_completed > 0 THEN time_completed
          WHEN time_created > 0 THEN time_created
        END,
        agent_name,
        session_id
      )
      WHERE cost > 0;
  `);

  if (columnExists(db, "session_cost_summary", "message_count")) return;
  db.exec(`

    INSERT OR REPLACE INTO session_cost_summary(
      agent_name,
      session_id,
      message_cost,
      untimed_message_cost
    )
    SELECT
      m.agent_name,
      m.session_id,
      SUM(CASE WHEN m.cost > 0 THEN m.cost ELSE 0 END),
      SUM(
        CASE
          WHEN m.cost > 0
            AND COALESCE(m.time_completed, 0) <= 0
            AND COALESCE(m.time_created, 0) <= 0
          THEN m.cost
          ELSE 0
        END
      )
    FROM messages m
    JOIN sessions s
      ON s.agent_name = m.agent_name
      AND s.session_id = m.session_id
    GROUP BY m.agent_name, m.session_id
  `);
}

function addSessionUsageSummary(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_cost_summary")) addSessionCostSummary(db);
  const columns: Record<string, string> = {
    message_count: "INTEGER NOT NULL DEFAULT 0",
    untimed_message_count: "INTEGER NOT NULL DEFAULT 0",
    input_tokens: "INTEGER NOT NULL DEFAULT 0",
    output_tokens: "INTEGER NOT NULL DEFAULT 0",
    reasoning_tokens: "INTEGER NOT NULL DEFAULT 0",
    cache_read_tokens: "INTEGER NOT NULL DEFAULT 0",
    cache_create_tokens: "INTEGER NOT NULL DEFAULT 0",
    untimed_input_tokens: "INTEGER NOT NULL DEFAULT 0",
    untimed_output_tokens: "INTEGER NOT NULL DEFAULT 0",
    untimed_reasoning_tokens: "INTEGER NOT NULL DEFAULT 0",
    untimed_cache_read_tokens: "INTEGER NOT NULL DEFAULT 0",
    untimed_cache_create_tokens: "INTEGER NOT NULL DEFAULT 0",
  };
  for (const [name, definition] of Object.entries(columns)) {
    if (!columnExists(db, "session_cost_summary", name)) {
      db.exec(`ALTER TABLE session_cost_summary ADD COLUMN ${name} ${definition}`);
    }
  }
  if (!tableExists(db, "messages")) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_messages_cost_time;
    CREATE INDEX IF NOT EXISTS idx_messages_usage_time
      ON messages(
        CASE
          WHEN time_completed > 0 THEN time_completed
          WHEN time_created > 0 THEN time_created
        END,
        agent_name,
        session_id
      );

    DELETE FROM session_cost_summary;
    WITH normalized AS (
      SELECT
        m.agent_name,
        m.session_id,
        COALESCE(m.time_completed, 0) <= 0 AND COALESCE(m.time_created, 0) <= 0 AS untimed,
        MAX(CAST(COALESCE(json_extract(m.tokens_json, '$.input'), 0) AS INTEGER), 0) AS input_tokens,
        MAX(CAST(COALESCE(json_extract(m.tokens_json, '$.output'), 0) AS INTEGER), 0) AS output_tokens,
        MAX(CAST(COALESCE(json_extract(m.tokens_json, '$.reasoning'), 0) AS INTEGER), 0) AS reasoning_tokens,
        MAX(CAST(COALESCE(json_extract(m.tokens_json, '$.cache_read'), 0) AS INTEGER), 0) AS cache_read_tokens,
        MAX(CAST(COALESCE(json_extract(m.tokens_json, '$.cache_create'), 0) AS INTEGER), 0) AS cache_create_tokens,
        CASE WHEN m.cost > 0 THEN m.cost ELSE 0 END AS cost
      FROM messages m
      JOIN sessions s
        ON s.agent_name = m.agent_name
        AND s.session_id = m.session_id
    )
    INSERT INTO session_cost_summary(
      agent_name,
      session_id,
      message_count,
      untimed_message_count,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_read_tokens,
      cache_create_tokens,
      untimed_input_tokens,
      untimed_output_tokens,
      untimed_reasoning_tokens,
      untimed_cache_read_tokens,
      untimed_cache_create_tokens,
      message_cost,
      untimed_message_cost
    )
    SELECT
      agent_name,
      session_id,
      COUNT(*),
      SUM(CASE WHEN untimed THEN 1 ELSE 0 END),
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(reasoning_tokens),
      SUM(cache_read_tokens),
      SUM(cache_create_tokens),
      SUM(CASE WHEN untimed THEN input_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN reasoning_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_read_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_create_tokens ELSE 0 END),
      SUM(cost),
      SUM(CASE WHEN untimed THEN cost ELSE 0 END)
    FROM normalized
    GROUP BY agent_name, session_id;
  `);
}

function compactSessionDocuments(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents")) {
    createSearchTables(db);
    return;
  }

  dropSearchTriggers(db);
  db.exec(`
    DROP TABLE IF EXISTS session_documents_fts;
    DROP TABLE IF EXISTS session_documents_legacy_v14;
    ALTER TABLE session_documents RENAME TO session_documents_legacy_v14;
  `);
  createSearchTables(db);
  db.exec(`
    INSERT INTO session_documents(
      id,
      agent_name,
      session_id,
      title,
      content_text,
      content_hash,
      indexed_message_count,
      indexed_at
    )
    SELECT
      id,
      agent_name,
      session_id,
      title,
      content_text,
      content_hash,
      indexed_message_count,
      indexed_at
    FROM session_documents_legacy_v14;

    DROP TABLE session_documents_legacy_v14;
  `);
}

function addMessagePartsFormatVersion(db: SQLiteDatabase): void {
  if (!tableExists(db, "messages") || columnExists(db, "messages", "parts_format_version")) {
    return;
  }
  db.exec("ALTER TABLE messages ADD COLUMN parts_format_version INTEGER NOT NULL DEFAULT 0");
}

function addMessageContentChainDigest(db: SQLiteDatabase): void {
  if (!tableExists(db, "messages") || columnExists(db, "messages", "content_chain_digest")) {
    return;
  }
  db.exec("ALTER TABLE messages ADD COLUMN content_chain_digest TEXT");
}

function addSessionParentReference(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) return;

  if (!columnExists(db, "sessions", "parent_agent_name")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_agent_name TEXT");
  }
  if (!columnExists(db, "sessions", "parent_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_agent_name, parent_session_id)",
  );
  recreateProjectGroupsView(db);
}

function dropDerivedSessionSlug(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions") || !columnExists(db, "sessions", "slug")) return;

  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS row_count,
          COALESCE(SUM(slug != agent_name || '/' || session_id), 0) AS mismatch_count
        FROM sessions
      `,
    )
    .get() as { row_count?: number; mismatch_count?: number } | undefined;
  const details = {
    row_count: Number(row?.row_count ?? 0),
    mismatch_count: Number(row?.mismatch_count ?? 0),
  };
  if (details.mismatch_count > 0) {
    getCoreDiagnostics()?.warn("sqlite.migration.session_identity.mismatch", details);
  } else {
    getCoreDiagnostics()?.info?.("sqlite.migration.session_identity.validated", details);
  }

  db.exec("ALTER TABLE sessions DROP COLUMN slug");
}

function dropLegacyCacheTables(db: SQLiteDatabase): void {
  db.exec(`
    DROP VIEW IF EXISTS project_groups_v;
    DROP TABLE IF EXISTS cached_sessions;
    DROP TABLE IF EXISTS project_sessions;
  `);
  recreateProjectGroupsView(db);
}

function setCacheMetaVersion(db: SQLiteDatabase): void {
  createCacheMetadataTables(db);
  db.prepare(
    `
      INSERT INTO cache_meta(key, value)
      VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(String(CACHE_SCHEMA_VERSION));
}

function setCacheSchemaVersion(db: SQLiteDatabase): void {
  setUserVersion(db, CACHE_SCHEMA_VERSION);
  setCacheMetaVersion(db);
}

export function ensureCacheSchema(db: SQLiteDatabase, dbPath: string): void {
  const currentVersion = getCurrentCacheSchemaVersion(db);
  if (currentVersion > CACHE_SCHEMA_VERSION) {
    throw new UnsupportedCacheSchemaVersionError(currentVersion, CACHE_SCHEMA_VERSION);
  }
  if (currentVersion === 0 && !hasAnyCacheSchema(db)) {
    createLatestCacheSchema(db);
    createSearchStateIndex(db);
    setCacheSchemaVersion(db);
    runCacheContentMigrations(db);
    return;
  }

  const resolveLegacyProjectIdentity = prepareLegacyProjectIdentityResolver(db, currentVersion);

  runSchemaMigrations(db, {
    dbPath,
    currentVersion,
    targetVersion: CACHE_SCHEMA_VERSION,
    backupLabel: "cache-migration",
    backupTables: [
      "agent_cache",
      "cache_initialization",
      "cached_sessions",
      "sessions",
      "messages",
      "message_tools",
      "session_file_activity",
      "session_documents",
      "project_sessions",
    ],
    migrations: [
      { version: 3, migrate: createLegacyCacheTables },
      { version: 4, migrate: createSearchTables },
      {
        version: 5,
        migrate: (migrationDb) => migrateProjectIdentity(migrationDb, resolveLegacyProjectIdentity),
      },
      {
        version: 6,
        destructive: true,
        migrate(db) {
          createLatestCacheSchema(db);
          recreateSearchIndexSchema(db);
          invalidateSearchContentHashes(db);
        },
      },
      {
        version: 7,
        migrate(db) {
          addSessionParentReference(db);
          backfillStructuredSessions(db, resolveLegacyProjectIdentity);
        },
      },
      { version: 8, migrate: backfillFileActivity },
      {
        version: 10,
        migrate(db) {
          createFileActivityPathSearchTables(db);
          rebuildFileActivityPathIndex(db);
        },
      },
      {
        version: 11,
        migrate(db) {
          backfillMessageTools(db);
        },
      },
      {
        version: 12,
        migrate(db) {
          refreshProjectIdentities(db, resolveLegacyProjectIdentity);
        },
      },
      { version: 13, migrate: createLegacyCacheTables },
      { version: 14, migrate: addIndexedMessageCount },
      { version: 15, destructive: true, migrate: compactSessionDocuments },
      { version: 17, migrate: addMessagePartsFormatVersion },
      { version: 18, migrate: addSessionParentReference },
      { version: 19, migrate: addDetailVersion },
      { version: 20, migrate: addProjectIdentityProvenance },
      { version: 21, migrate: addSessionPublicationId },
      { version: 22, migrate: addAtomicPublicationStaging },
      { version: 23, migrate: replaceSessionActivityIndex },
      { version: 24, migrate: dropLegacyMessageSearchIndex },
      { version: 25, migrate: addMessageContentChainDigest },
      { version: 26, migrate: addSessionActivityIndex },
      { version: 27, migrate: addSessionModelCostRollup },
      { version: 28, migrate: addSessionCostSummary },
      { version: 29, migrate: addSessionUsageSummary },
      { version: 30, destructive: true, migrate: dropDerivedSessionSlug },
      { version: 31, migrate: dropDurablePublicationStaging },
      { version: 32, destructive: true, migrate: dropLegacyCacheTables },
    ],
  });

  createLatestCacheSchema(db);
  createSearchStateIndex(db);

  // Only stamp when behind: every thread's first connection runs ensureSchema,
  // and an unconditional PRAGMA user_version write would contend for the write
  // lock against concurrent checkpoint/index writers on every startup.
  const userVersion = getUserVersion(db);
  if (userVersion < CACHE_SCHEMA_VERSION) {
    setCacheSchemaVersion(db);
  } else if (
    userVersion === CACHE_SCHEMA_VERSION &&
    readLegacyCacheVersion(db) !== CACHE_SCHEMA_VERSION
  ) {
    setCacheMetaVersion(db);
  }

  runCacheContentMigrations(db);
}
