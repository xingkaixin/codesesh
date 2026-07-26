import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setFtsIntegrityCheckedPath, setSchemaEnsuredPath } from "../db.js";
import * as schema from "../schema.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-schema-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

beforeEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

afterEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
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
    expect(state?.version).toBe(15);
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
});
