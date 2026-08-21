import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { SQLiteDatabase } from "../../../utils/sqlite.js";
import { runCacheContentMigrations } from "../content-migrations.js";

type TestDatabase = Database.Database & SQLiteDatabase;

function createDatabase(): TestDatabase {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
    CREATE TABLE pending_reindex (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
    CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY
    );
  `);
  return db as unknown as TestDatabase;
}

function seedAgentCache(db: TestDatabase): void {
  const insert = db.prepare("INSERT OR REPLACE INTO agent_cache(agent_name) VALUES (?)");
  for (const agentName of ["codex", "opencode", "zcode", "cursor"]) insert.run(agentName);
}

describe("cache content migrations", () => {
  it("invalidates affected content once without coupling it to the schema version", () => {
    const db = createDatabase();
    try {
      db.exec(`
        INSERT INTO sessions(agent_name, session_id) VALUES ('codex', 'codex-session');
        INSERT INTO sessions(agent_name, session_id) VALUES ('cursor', 'cursor-session');
      `);
      seedAgentCache(db);

      runCacheContentMigrations(db);

      expect(db.prepare("SELECT * FROM pending_reindex").all()).toEqual([
        { agent_name: "codex", session_id: "codex-session" },
      ]);
      expect(db.prepare("SELECT agent_name FROM agent_cache ORDER BY agent_name").all()).toEqual([
        { agent_name: "cursor" },
      ]);
      expect(db.prepare("SELECT key, value FROM cache_meta ORDER BY key").all()).toEqual([
        { key: "codex_exec_decode_migrated_v3", value: "1" },
        { key: "opencode_subagent_fold_v1", value: "1" },
        { key: "subagent_tree_v1", value: "1" },
      ]);

      seedAgentCache(db);
      runCacheContentMigrations(db);

      expect(db.prepare("SELECT agent_name FROM agent_cache ORDER BY agent_name").all()).toEqual([
        { agent_name: "codex" },
        { agent_name: "cursor" },
        { agent_name: "opencode" },
        { agent_name: "zcode" },
      ]);
    } finally {
      db.close();
    }
  });
});
