import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachePath, setSchemaEnsuredPath } from "../db.js";
import * as schema from "../schema.js";

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
      "indexed_at",
    ]);
    expect(state?.messageColumns).toContain("parts_format_version");
    expect(state?.version).toBe(18);
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
        version: 18,
        partsJson: legacyPartsJson,
        partsFormatVersion: 0,
      });
    },
  );
});
