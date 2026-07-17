import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { SQLiteDatabase } from "../../../utils/sqlite.js";
import {
  CACHE_SCHEMA_VERSION,
  createLatestCacheSchema,
  getCurrentCacheSchemaVersion,
  hasAnyCacheSchema,
  inferCacheSchemaVersion,
  setCacheSchemaVersion,
} from "../schema.js";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("cache schema", () => {
  it("creates the complete current schema", () => {
    db = new Database(":memory:");
    const cacheDb = db as unknown as SQLiteDatabase;
    createLatestCacheSchema(cacheDb);
    setCacheSchemaVersion(cacheDb);

    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string; type: string }>;
    const names = new Set(objects.map((row) => row.name));

    expect(names.has("sessions")).toBe(true);
    expect(names.has("messages")).toBe(true);
    expect(names.has("session_documents")).toBe(true);
    expect(names.has("session_file_activity")).toBe(true);
    expect(names.has("project_groups_v")).toBe(true);
    expect(getCurrentCacheSchemaVersion(cacheDb)).toBe(CACHE_SCHEMA_VERSION);
    expect(inferCacheSchemaVersion(cacheDb)).toBe(CACHE_SCHEMA_VERSION);
    expect(hasAnyCacheSchema(cacheDb)).toBe(true);
  });

  it("recognizes an empty database", () => {
    db = new Database(":memory:");
    const cacheDb = db as unknown as SQLiteDatabase;

    expect(getCurrentCacheSchemaVersion(cacheDb)).toBe(0);
    expect(inferCacheSchemaVersion(cacheDb)).toBe(0);
    expect(hasAnyCacheSchema(cacheDb)).toBe(false);
  });
});
