import { tableExists, type SQLiteDatabase } from "../../utils/sqlite.js";

interface CacheContentMigration {
  readonly key: string;
  readonly apply: (db: SQLiteDatabase) => void;
}

const CACHE_CONTENT_MIGRATIONS: readonly CacheContentMigration[] = [
  {
    key: "codex_exec_decode_migrated_v3",
    apply(db) {
      if (!tableExists(db, "sessions") || !tableExists(db, "pending_reindex")) return;
      // Head hashes stay stable when only detail decoding changes, so queue targeted rebuilds.
      db.exec(
        "INSERT OR IGNORE INTO pending_reindex(agent_name, session_id) " +
          "SELECT agent_name, session_id FROM sessions WHERE agent_name = 'codex'",
      );
    },
  },
  {
    key: "opencode_subagent_fold_v1",
    apply(db) {
      if (!tableExists(db, "agent_cache")) return;
      db.prepare("DELETE FROM agent_cache WHERE agent_name IN ('zcode', 'opencode')").run();
    },
  },
  {
    key: "subagent_tree_v1",
    apply(db) {
      if (!tableExists(db, "agent_cache")) return;
      db.prepare(
        "DELETE FROM agent_cache WHERE agent_name IN ('codex', 'zcode', 'opencode')",
      ).run();
    },
  },
];

export function runCacheContentMigrations(db: SQLiteDatabase): void {
  if (!tableExists(db, "cache_meta")) return;

  const readMarker = db.prepare("SELECT value FROM cache_meta WHERE key = ?");
  const writeMarker = db.prepare(
    "INSERT INTO cache_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
  );

  for (const migration of CACHE_CONTENT_MIGRATIONS) {
    if (readMarker.get(migration.key)) continue;
    migration.apply(db);
    writeMarker.run(migration.key);
  }
}
