import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLiteDatabase } from "../../../utils/sqlite.js";
import { getCachePath, setSchemaEnsuredPath } from "../db.js";
import * as schema from "../schema.js";
import { loadCachedSessions, saveCachedSessions } from "../sessions.js";
import { syncSessionSearchIndex } from "../search-index-writer.js";
import { makeSessionData, makeSessionHead } from "./fixtures.js";
import { setCoreDiagnostics } from "../../../utils/diagnostics.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-schema-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

function readPublicationCounts(db: SQLiteDatabase) {
  const sessions = db
    .prepare("SELECT COUNT(*) AS value FROM sessions WHERE publication_id IS NOT NULL")
    .get() as { value?: number };
  const documents = db
    .prepare("SELECT COUNT(*) AS value FROM session_documents WHERE agent_name = ?")
    .get("codex") as { value?: number };
  return {
    sessions: Number(sessions.value ?? 0),
    documents: Number(documents.value ?? 0),
  };
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
});

describe("cache schema boundary", () => {
  it("opens an empty cache with the complete current schema", () => {
    const state = schema.withCacheDb((db) => {
      const objects = db
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      return {
        names: new Set(objects.map((row) => row.name)),
        documentColumns: (
          db.prepare("PRAGMA table_info(session_documents)").all() as Array<{ name: string }>
        ).map((row) => row.name),
        messageColumns: (
          db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
        ).map((row) => row.name),
        sessionColumns: (
          db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
        ).map((row) => row.name),
        version: Number(
          (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
            ?.user_version ?? 0,
        ),
      };
    });

    for (const name of [
      "sessions",
      "messages",
      "session_cost_summary",
      "session_documents",
      "session_file_activity",
      "project_groups_v",
    ]) {
      expect(state?.names.has(name)).toBe(true);
    }
    expect(state?.names.has("messages_fts")).toBe(false);
    expect(state?.names.has("search_index_publication_entries")).toBe(false);
    expect(state?.documentColumns).toEqual([
      "id",
      "agent_name",
      "session_id",
      "title",
      "content_text",
      "content_hash",
      "indexed_message_count",
      "detail_version",
      "indexed_at",
    ]);
    expect(state?.messageColumns).toContain("parts_format_version");
    expect(state?.messageColumns).toContain("content_chain_digest");
    expect(state?.sessionColumns).toEqual(
      expect.arrayContaining([
        "project_identity_resolver_revision",
        "project_identity_input_signature",
        "smart_tags_classifier_revision",
        "publication_id",
      ]),
    );
    expect(state?.version).toBe(31);
  });

  it("derives session identity from the composite key when upgrading schema 29", () => {
    const session = makeSessionHead("identity");
    saveCachedSessions("codex", [session]);
    schema.withCacheDb((db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN slug TEXT NOT NULL DEFAULT '';
        UPDATE sessions SET slug = 'wrong/value';
        PRAGMA user_version = 29;
      `);
    });
    setSchemaEnsuredPath(null);
    const warnings: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => warnings.push({ event, detail }) });

    try {
      const restored = loadCachedSessions("codex")?.sessions[0];
      const columns = schema.withCacheDb((db) =>
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );

      expect(restored?.reference).toEqual({ agentName: "codex", sessionId: "identity" });
      expect(restored?.id).toBe("identity");
      expect(restored?.slug).toBe("codex/identity");
      expect(columns).not.toContain("slug");
      expect(warnings).toContainEqual({
        event: "sqlite.migration.session_identity.mismatch",
        detail: { row_count: 1, mismatch_count: 1 },
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("removes the legacy message FTS objects when upgrading schema 23", () => {
    schema.withCacheDb((db) => {
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content_text,
          content='messages',
          content_rowid='rowid'
        );
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
        END;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content_text)
          VALUES ('delete', old.rowid, old.content_text);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content_text)
          VALUES ('delete', old.rowid, old.content_text);
          INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
        END;
        PRAGMA user_version = 23;
        UPDATE cache_meta SET value = '23' WHERE key = 'version';
      `);
    });
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((db) => ({
      objects: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('messages_fts', 'messages_ai', 'messages_ad', 'messages_au')",
        )
        .all(),
      version: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
          ?.user_version ?? 0,
      ),
    }));

    expect(migrated).toEqual({ objects: [], version: 31 });
  });

  it("adds an empty hash chain column when upgrading schema 24", () => {
    const session = makeSessionHead("legacy-chain");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => makeSessionData(session.id));

    const legacyDb = new Database(getCachePath());
    try {
      legacyDb.exec("ALTER TABLE messages DROP COLUMN content_chain_digest");
      legacyDb.pragma("user_version = 24");
      legacyDb.prepare("UPDATE cache_meta SET value = '24' WHERE key = 'version'").run();
    } finally {
      legacyDb.close();
    }
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((db) => ({
      version: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
      ),
      digest: (
        db
          .prepare("SELECT content_chain_digest FROM messages WHERE session_id = ?")
          .get(session.id) as { content_chain_digest?: string | null }
      ).content_chain_digest,
    }));

    expect(migrated).toEqual({ version: 31, digest: null });
  });

  it("backfills session usage summaries when upgrading schema 28", () => {
    const session = makeSessionHead("cost-summary", {
      stats: {
        message_count: 2,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 3,
        cost_source: "estimated",
      },
    });
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => ({
      ...makeSessionData(session.id),
      ...session,
      messages: [
        {
          id: "timed",
          role: "assistant" as const,
          time_created: 100,
          cost: 1,
          cost_source: "estimated" as const,
          parts: [],
        },
        {
          id: "untimed",
          role: "assistant" as const,
          time_created: 0,
          cost: 2,
          cost_source: "estimated" as const,
          parts: [],
        },
      ],
    }));

    const legacyDb = new Database(getCachePath());
    legacyDb.exec(`
      DROP INDEX idx_messages_usage_time;
      DROP TABLE session_cost_summary;
      CREATE TABLE session_cost_summary (
        agent_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_cost REAL NOT NULL,
        untimed_message_cost REAL NOT NULL,
        PRIMARY KEY (agent_name, session_id)
      );
      CREATE INDEX idx_messages_cost_time
        ON messages(
          CASE
            WHEN time_completed > 0 THEN time_completed
            WHEN time_created > 0 THEN time_created
          END,
          agent_name,
          session_id
        )
        WHERE cost > 0;
      PRAGMA user_version = 28;
      UPDATE cache_meta SET value = '28' WHERE key = 'version';
    `);
    legacyDb.close();
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((db) => ({
      version: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
      ),
      summary: db
        .prepare(
          `SELECT
            message_count,
            untimed_message_count,
            input_tokens,
            output_tokens,
            message_cost,
            untimed_message_cost
          FROM session_cost_summary
          WHERE agent_name = ? AND session_id = ?`,
        )
        .get("codex", session.id),
      hasIndex:
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("idx_messages_usage_time") != null,
    }));

    expect(migrated).toEqual({
      version: 31,
      summary: {
        message_count: 2,
        untimed_message_count: 1,
        input_tokens: 0,
        output_tokens: 0,
        message_cost: 3,
        untimed_message_cost: 2,
      },
      hasIndex: true,
    });
  });

  it("reuses one connection for read and write capabilities until invalidated", () => {
    const writeConnection = schema.withCacheDb((db) => db);
    const nextWriteConnection = schema.withCacheDb((db) => db);
    const readConnection = schema.withCacheDbReadOnly((db) => db);

    expect(nextWriteConnection).toBe(writeConnection);
    expect(readConnection).toEqual({ status: "success", value: writeConnection });

    setSchemaEnsuredPath(null);

    expect(schema.withCacheDb((db) => db)).not.toBe(writeConnection);
  });

  it("checks the FTS schema only on the first search for a connection", () => {
    schema.withCacheDb(() => undefined);
    const prepare = vi.spyOn(Database.prototype, "prepare");

    schema.withSearchDb(() => undefined);
    const firstProbeCount = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("sqlite_master"),
    ).length;

    schema.withSearchDb(() => undefined);
    const secondProbeCount = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("sqlite_master"),
    ).length;
    prepare.mockRestore();

    expect(firstProbeCount).toBeGreaterThan(0);
    expect(secondProbeCount).toBe(firstProbeCount);
  });

  it("defers orphaned v21 publication cleanup until the first search-index write", () => {
    const session = makeSessionHead("orphaned-publication");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => makeSessionData(session.id));

    const db = new Database(getCachePath());
    try {
      db.prepare("UPDATE sessions SET publication_id = ? WHERE session_id = ?").run(
        "orphaned",
        session.id,
      );
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    const beforeCleanup = schema.withCacheDb(readPublicationCounts);

    expect(beforeCleanup).toEqual({ sessions: 1, documents: 1 });

    const afterCleanup = schema.withSearchIndexDb(readPublicationCounts);

    expect(afterCleanup).toEqual({ sessions: 0, documents: 0 });
  });

  it("skips cleanup scans after an empty staging probe", () => {
    schema.withCacheDb(() => undefined);
    const prepare = vi.spyOn(Database.prototype, "prepare");

    schema.withSearchIndexDb(() => undefined);
    const firstProbeCount = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT 1 FROM sessions WHERE publication_id IS NOT NULL LIMIT 1"),
    ).length;
    const cleanupStatementCount = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("DELETE FROM"),
    ).length;

    schema.withSearchIndexDb(() => undefined);
    const secondProbeCount = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT 1 FROM sessions WHERE publication_id IS NOT NULL LIMIT 1"),
    ).length;
    prepare.mockRestore();

    expect(firstProbeCount).toBe(1);
    expect(secondProbeCount).toBe(firstProbeCount);
    expect(cleanupStatementCount).toBe(0);
  });

  it("invalidates v21 detail rows so inconsistent publications rebuild", () => {
    const session = makeSessionHead("publication-rebuild");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => makeSessionData(session.id));

    const db = new Database(getCachePath());
    try {
      db.prepare("UPDATE session_documents SET content_hash = ? WHERE session_id = ?").run(
        "stale-but-matching",
        session.id,
      );
      db.pragma("user_version = 21");
      db.prepare("UPDATE cache_meta SET value = '21' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((ready) => ({
      contentHash: String(
        (
          ready
            .prepare("SELECT content_hash FROM session_documents WHERE session_id = ?")
            .get(session.id) as { content_hash?: string }
        ).content_hash ?? "missing",
      ),
      pending:
        ready
          .prepare("SELECT 1 FROM pending_reindex WHERE agent_name = ? AND session_id = ?")
          .get("codex", session.id) != null,
    }));

    expect(migrated).toEqual({ contentHash: "", pending: true });
  });

  it("exposes capabilities instead of migration steps", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "runSearchIndexWrite",
      "withCacheDb",
      "withCacheDbOutcome",
      "withCacheDbReadOnly",
      "withSearchDb",
      "withSearchIndexDb",
    ]);
  });

  it("marks existing details for validation when adding projection versions", () => {
    const session = makeSessionHead("legacy-detail");
    saveCachedSessions("codex", [session], {
      [session.id]: { id: session.id, sourcePath: "/legacy", sourceFingerprint: "legacy" },
    });
    syncSessionSearchIndex("codex", [session], () => makeSessionData(session.id));

    const legacyDb = new Database(getCachePath());
    // A real v18 database predates both the projection version and the index over it.
    legacyDb.exec("DROP INDEX idx_session_documents_state");
    legacyDb.exec("ALTER TABLE session_documents DROP COLUMN detail_version");
    legacyDb.pragma("user_version = 18");
    legacyDb.prepare("UPDATE cache_meta SET value = '18' WHERE key = 'version'").run();
    legacyDb.close();
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((db) => ({
      version: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
      ),
      detailVersion: (
        db
          .prepare(
            "SELECT detail_version FROM session_documents WHERE agent_name = ? AND session_id = ?",
          )
          .get("codex", session.id) as { detail_version?: string }
      ).detail_version,
      pending:
        db
          .prepare("SELECT 1 FROM pending_reindex WHERE agent_name = ? AND session_id = ?")
          .get("codex", session.id) != null,
    }));

    expect(migrated).toEqual({ version: 31, detailVersion: "", pending: true });
  });

  it("marks legacy project identities stale by leaving added provenance empty", () => {
    const session = makeSessionHead("legacy-identity");
    saveCachedSessions("codex", [session], {});

    const legacyDb = new Database(getCachePath());
    legacyDb.exec("ALTER TABLE sessions DROP COLUMN project_identity_resolver_revision");
    legacyDb.exec("ALTER TABLE sessions DROP COLUMN project_identity_input_signature");
    legacyDb.exec("ALTER TABLE sessions DROP COLUMN smart_tags_classifier_revision");
    legacyDb.pragma("user_version = 19");
    legacyDb.prepare("UPDATE cache_meta SET value = '19' WHERE key = 'version'").run();
    legacyDb.close();
    setSchemaEnsuredPath(null);

    const migrated = schema.withCacheDb((db) => {
      const row = db
        .prepare(
          `SELECT project_identity_resolver_revision, project_identity_input_signature,
                  smart_tags_classifier_revision
           FROM sessions WHERE session_id = ?`,
        )
        .get(session.id) as {
        project_identity_resolver_revision?: string | null;
        project_identity_input_signature?: string | null;
        smart_tags_classifier_revision?: string | null;
      };
      return {
        version: Number(
          (db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
        ),
        resolverRevision: row.project_identity_resolver_revision,
        inputSignature: row.project_identity_input_signature,
        classifierRevision: row.smart_tags_classifier_revision,
      };
    });

    expect(migrated).toEqual({
      version: 31,
      resolverRevision: null,
      inputSignature: null,
      classifierRevision: null,
    });
  });

  it.each([15, 16])(
    "upgrades a v%s cache without rewriting legacy message payloads",
    (legacyVersion) => {
      schema.withCacheDb(() => undefined);

      const legacyDb = new Database(getCachePath());
      legacyDb.pragma("foreign_keys = OFF");
      legacyDb.exec("ALTER TABLE messages DROP COLUMN parts_format_version");
      const legacyPartsJson = JSON.stringify([
        {
          type: "tool",
          tool: "Read",
          state: { status: "success", arguments: { path: "src/a.ts" }, result: "done" },
        },
      ]);
      legacyDb
        .prepare(
          `
            INSERT INTO messages(
              agent_name,
              session_id,
              message_index,
              message_id,
              role,
              time_created,
              parts_json,
              content_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run("codex", "legacy", 0, "m1", "assistant", 1, legacyPartsJson, "legacy");
      legacyDb.exec(`
        CREATE TRIGGER reject_message_parts_rewrite
        BEFORE UPDATE OF parts_json ON messages
        BEGIN
          SELECT RAISE(ABORT, 'legacy message payload must not be rewritten');
        END;
      `);
      legacyDb.pragma(`user_version = ${legacyVersion}`);
      legacyDb
        .prepare("UPDATE cache_meta SET value = ? WHERE key = 'version'")
        .run(String(legacyVersion));
      legacyDb.close();
      setSchemaEnsuredPath(null);

      const migrated = schema.withCacheDb((db) => {
        const row = db
          .prepare("SELECT parts_json, parts_format_version FROM messages WHERE message_id = 'm1'")
          .get() as {
          parts_json?: string;
          parts_format_version?: number;
        };
        return {
          version: Number(
            (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
              ?.user_version ?? 0,
          ),
          partsJson: row.parts_json,
          partsFormatVersion: Number(row.parts_format_version),
        };
      });

      expect(migrated).toEqual({
        version: 31,
        partsJson: legacyPartsJson,
        partsFormatVersion: 0,
      });
    },
  );
});
