import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachePath, setSchemaEnsuredPath } from "../db.js";
import * as schema from "../schema.js";
import { saveCachedSessions } from "../sessions.js";
import { syncSessionSearchIndex } from "../search-index-writer.js";
import { makeSessionData, makeSessionHead } from "./fixtures.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-schema-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

beforeEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setSchemaEnsuredPath(null);
});

afterEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setSchemaEnsuredPath(null);
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
      "session_documents",
      "session_file_activity",
      "project_groups_v",
      "search_index_publication_entries",
    ]) {
      expect(state?.names.has(name)).toBe(true);
    }
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
    expect(state?.sessionColumns).toEqual(
      expect.arrayContaining([
        "project_identity_resolver_revision",
        "project_identity_input_signature",
        "smart_tags_classifier_revision",
        "publication_id",
      ]),
    );
    expect(state?.version).toBe(22);
  });

  it("reclaims orphaned publication rows on the next schema open", () => {
    const session = makeSessionHead("orphaned-publication");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => makeSessionData(session.id));

    const db = new Database(getCachePath());
    try {
      db.prepare("UPDATE sessions SET publication_id = ? WHERE session_id = ?").run(
        "orphaned",
        session.id,
      );
      db.prepare(
        `
          INSERT INTO search_index_publication_entries(
            publication_id,
            agent_name,
            session_id,
            payload_json
          ) VALUES (?, ?, ?, ?)
        `,
      ).run("orphaned", "codex", session.id, "{}");
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    const counts = schema.withCacheDb((ready) => ({
      sessions: Number(
        (
          ready
            .prepare("SELECT COUNT(*) AS value FROM sessions WHERE publication_id IS NOT NULL")
            .get() as { value?: number }
        ).value ?? 0,
      ),
      documents: Number(
        (
          ready
            .prepare("SELECT COUNT(*) AS value FROM session_documents WHERE agent_name = ?")
            .get("codex") as { value?: number }
        ).value ?? 0,
      ),
      payloads: Number(
        (
          ready.prepare("SELECT COUNT(*) AS value FROM search_index_publication_entries").get() as {
            value?: number;
          }
        ).value ?? 0,
      ),
    }));

    expect(counts).toEqual({ sessions: 0, documents: 0, payloads: 0 });
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

    expect(migrated).toEqual({ version: 22, detailVersion: "", pending: true });
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
      version: 22,
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
        version: 22,
        partsJson: legacyPartsJson,
        partsFormatVersion: 0,
      });
    },
  );
});
