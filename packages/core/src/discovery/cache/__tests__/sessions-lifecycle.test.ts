import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getAgentFullSyncCursor,
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  markAgentCacheInitialized,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  readAgentCacheInitialization,
  readAgentLastFullSyncAt,
  readCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
  type CachedResult,
} from "../sessions.js";
import { listCachedProjectGroups } from "../project-groups.js";
import type { SessionCacheMeta } from "../../../agents/base.js";
import { setCoreDiagnostics } from "../../../utils/diagnostics.js";
import { clearIdentityCache } from "../../../projects/identity.js";
import { realFs } from "../../../projects/fs.js";
import { withCacheDb, withSearchIndexDb } from "../connection.js";
import { getSchemaEnsuredPath, setSchemaEnsuredPath } from "../db.js";
import { CACHE_SCHEMA_VERSION } from "../version.js";
import type { SessionHead } from "../../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

const now = Date.now();
const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

const CACHE_DATA_TABLES = [
  "agent_cache",
  "cache_initialization",
  "pending_reindex",
  "session_documents",
  "session_file_activity",
  "message_tools",
  "messages",
  "sessions",
] as const;

const SESSION_OWNED_DATA_TABLES = [
  "pending_reindex",
  "session_documents",
  "session_file_activity",
  "message_tools",
  "messages",
  "session_model_cost",
  "session_cost_summary",
  "sessions",
] as const;

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), "scan-cache.json");
}

function readCachedValue(agentName: string): CachedResult | null {
  const outcome = readCachedSessions(agentName);
  expect(outcome.status).toBe("success");
  return outcome.status === "success" ? outcome.value : null;
}

// Isolated temp directory for session fixtures so computeIdentity always
// resolves to a "path" identity regardless of what manifests exist in /tmp.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-identity-"));
const FIXTURE_DIR_NAME = FIXTURE_DIR.split(/[\\/]/).pop()!;

function makeSession(id: string, agentName = "claudecode"): SessionHead {
  return {
    reference: { agentName, sessionId: id },
    title: `Session ${id}`,
    directory: FIXTURE_DIR,
    project_identity: {
      kind: "path",
      key: FIXTURE_DIR,
      displayName: FIXTURE_DIR_NAME,
    },
    time_created: now,
    time_updated: now,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function createLegacyCacheTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );
  `);
}

function createLegacyCachedSessionDb(version: number, session = makeSession("legacy")): void {
  mkdirSync(getCacheDir(), { recursive: true });
  const db = new Database(getCachePath());
  try {
    createLegacyCacheTables(db);
    db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', ?)").run(String(version));
    db.prepare("INSERT INTO agent_cache(agent_name, timestamp) VALUES (?, ?)").run(
      "claudecode",
      now,
    );
    db.prepare(
      `
        INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json)
        VALUES (?, ?, ?, ?)
      `,
    ).run("claudecode", session.reference.sessionId, JSON.stringify(session), null);
  } finally {
    db.close();
  }
}

function getUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

function getMigrationBackups(): string[] {
  return readdirSync(getCacheDir()).filter((name) => name.endsWith(".cache-migration.bak"));
}

function cacheDataTableCounts(
  db: Database.Database,
): Record<(typeof CACHE_DATA_TABLES)[number], number> {
  return Object.fromEntries(
    CACHE_DATA_TABLES.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value?: number };
      return [table, Number(row.value ?? 0)];
    }),
  ) as Record<(typeof CACHE_DATA_TABLES)[number], number>;
}

function emptyCacheDataTableCounts(): Record<(typeof CACHE_DATA_TABLES)[number], number> {
  return Object.fromEntries(CACHE_DATA_TABLES.map((table) => [table, 0])) as Record<
    (typeof CACHE_DATA_TABLES)[number],
    number
  >;
}

function seedSessionOwnedRows(): void {
  saveCachedSessions("claudecode", [makeSession("removed")]);
  withCacheDb((db) => {
    db.exec(`
      INSERT INTO pending_reindex(agent_name, session_id)
      VALUES ('claudecode', 'removed');
      INSERT INTO session_documents(
        agent_name, session_id, title, content_text, content_hash,
        indexed_message_count, detail_version, indexed_at
      ) VALUES ('claudecode', 'removed', 'title', 'content', 'hash', 1, 'detail-v1', ${now});
      INSERT INTO messages(
        agent_name, session_id, message_index, message_id, role, time_created,
        parts_json, content_text
      ) VALUES ('claudecode', 'removed', 0, 'message-1', 'assistant', ${now}, '[]', 'content');
      INSERT INTO message_tools(agent_name, session_id, message_index, tool_name)
      VALUES ('claudecode', 'removed', 0, 'write');
      INSERT INTO session_model_cost(
        agent_name, session_id, model, cost, cost_recorded
      ) VALUES ('claudecode', 'removed', 'test-model', 1, 1);
      INSERT INTO session_cost_summary(
        agent_name, session_id, message_cost, untimed_message_cost
      ) VALUES ('claudecode', 'removed', 1, 0);
      INSERT INTO session_file_activity(
        agent_name, session_id, project_identity_key, path, kind, count, latest_time
      ) VALUES ('claudecode', 'removed', '${FIXTURE_DIR}', 'src/index.ts', 'write', 1, ${now});
    `);
  });
}

function sessionOwnedDataTableCounts(): Record<(typeof SESSION_OWNED_DATA_TABLES)[number], number> {
  return withCacheDb(
    (db) =>
      Object.fromEntries(
        SESSION_OWNED_DATA_TABLES.map((table) => {
          const row = db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
            value?: number;
          };
          return [table, Number(row.value ?? 0)];
        }),
      ) as Record<(typeof SESSION_OWNED_DATA_TABLES)[number], number>,
  )!;
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  dateNowSpy.mockReturnValue(now);
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  setCoreDiagnostics(null);
});
describe("readCachedSessions", () => {
  it("returns null when cache db does not exist", () => {
    expect(readCachedValue("claudecode")).toBeNull();
  });

  it("returns null when agent is not cached", () => {
    saveCachedSessions("cursor", [makeSession("s1", "cursor")]);
    expect(readCachedValue("claudecode")).toBeNull();
  });

  it("returns cached sessions even when last refresh is old", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    dateNowSpy.mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    expect(
      readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["s1"]);
  });

  it("returns cached sessions and meta when valid", () => {
    const meta: Record<string, SessionCacheMeta> = {
      s1: { id: "s1", sourcePath: "/path/to/source" },
    };

    saveCachedSessions("claudecode", [makeSession("s1")], meta);

    const result = readCachedValue("claudecode");
    expect(result).not.toBeNull();
    expect(result?.sessions).toHaveLength(1);
    expect(result?.sessions[0]?.reference.sessionId).toBe("s1");
    expect(result?.meta.s1?.sourcePath).toBe("/path/to/source");
    expect(result?.timestamp).toBe(now);
  });

  it("preserves empty cached results", () => {
    saveCachedSessions("claudecode", []);
    const result = readCachedValue("claudecode");
    expect(result).toEqual({
      sessions: [],
      meta: {},
      timestamp: now,
    });
  });
});

describe("session identity persistence invariant", () => {
  it("rejects a session owned by another agent before opening the cache", () => {
    const session = makeSession("session", "codex");

    expect(() => saveCachedSessions("claudecode", [session])).toThrow(
      'Session reference agent "codex" does not match "claudecode"',
    );
    expect(existsSync(getCachePath())).toBe(false);
  });

  it("fails before opening the cache when a session identity is missing", () => {
    const spawnSpy = vi.spyOn(realFs, "spawn");
    const session = { ...makeSession("missing-identity"), project_identity: undefined };

    expect(() => saveCachedSessions("claudecode", [session])).toThrow(
      "Session claudecode/missing-identity is missing project_identity",
    );
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(existsSync(getCachePath())).toBe(false);
  });

  it("rejects cached rows whose project identity is missing", () => {
    saveCachedSessions("claudecode", [makeSession("corrupt-identity")]);
    withCacheDb((db) => {
      db.prepare(
        "UPDATE sessions SET project_identity_key = '' WHERE agent_name = ? AND session_id = ?",
      ).run("claudecode", "corrupt-identity");
    });

    expect(readCachedSessions("claudecode")).toEqual({ status: "failed" });
  });
});

describe("withSearchIndexDb", () => {
  it("provides ready search-index tables", () => {
    const tables = withSearchIndexDb((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_documents_fts'").all(),
    );

    expect(tables).toHaveLength(1);
  });
});

describe("withCacheDb schema memo", () => {
  it("runs ensureSchema on the first open but skips it on later opens for the same path", () => {
    withCacheDb(() => undefined);
    expect(getSchemaEnsuredPath()).toBe(getCachePath());
    expect(getUserVersion(getCachePath())).toBe(CACHE_SCHEMA_VERSION);

    const db = new Database(getCachePath());
    db.pragma("user_version = 14");
    db.close();

    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(14);

    setSchemaEnsuredPath(null);
    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(CACHE_SCHEMA_VERSION);
  });
});

describe("saveCachedSessions", () => {
  it("creates sqlite cache db", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(readFileSync(getCachePath()).byteLength).toBeGreaterThan(0);
    expect(getUserVersion(getCachePath())).toBe(CACHE_SCHEMA_VERSION);
  });

  it("writes structured session rows for cache restores", () => {
    const session = {
      ...makeSession("s1"),
      stats: {
        message_count: 3,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0.12,
        total_tokens: 20,
        total_cache_read_tokens: 2,
      },
      model_usage: { "claude-sonnet": 20 },
      project_identity_resolver_revision: "resolver-v1",
      project_identity_input_signature: "identity-input-v1",
      smart_tags: ["feature-dev" as const],
      smart_tags_source_updated_at: now,
      smart_tags_classifier_revision: "smart-tags-v1",
    };

    saveCachedSessions("claudecode", [session], {
      s1: { id: "s1", sourcePath: "/path/to/source" },
    });

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const row = db.prepare("SELECT * FROM sessions WHERE agent_name = ?").get("claudecode") as {
        session_id?: string;
        source_path?: string;
        message_count?: number;
        total_tokens?: number;
        model_usage_json?: string;
        smart_tags_json?: string;
        smart_tags_classifier_revision?: string;
        project_identity_resolver_revision?: string;
        project_identity_input_signature?: string;
      };

      expect(row.session_id).toBe("s1");
      expect(row.source_path).toBe("/path/to/source");
      expect(row.message_count).toBe(3);
      expect(row.total_tokens).toBe(20);
      expect(JSON.parse(row.model_usage_json ?? "{}")).toEqual({ "claude-sonnet": 20 });
      expect(JSON.parse(row.smart_tags_json ?? "[]")).toEqual(["feature-dev"]);
      expect(row.smart_tags_classifier_revision).toBe("smart-tags-v1");
      expect(row.project_identity_resolver_revision).toBe("resolver-v1");
      expect(row.project_identity_input_signature).toBe("identity-input-v1");
      expect(readCachedValue("claudecode")?.sessions[0]).toMatchObject({
        project_identity_resolver_revision: "resolver-v1",
        project_identity_input_signature: "identity-input-v1",
        smart_tags_classifier_revision: "smart-tags-v1",
      });
    } finally {
      db.close();
    }
  });

  it("writes session heads only to the canonical sessions table", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    saveCachedSessionChanges(
      "claudecode",
      [{ session: { ...makeSession("s1"), title: "Updated" }, sortIndex: 0 }],
      [],
    );

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS value FROM sessions").get() as { value?: number };
      const legacyTableCount = db
        .prepare(
          "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name IN ('cached_sessions', 'project_sessions')",
        )
        .get() as { value?: number };
      expect(Number(row.value ?? 0)).toBe(1);
      expect(Number(legacyTableCount.value ?? 0)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("overwrites cached rows for the same agent", () => {
    saveCachedSessions("claudecode", [makeSession("old")]);
    saveCachedSessions("claudecode", [makeSession("new")]);

    const result = readCachedValue("claudecode");
    expect(result?.sessions.map((session) => session.reference.sessionId)).toEqual(["new"]);
  });

  it("preserves cached rows for an empty partial snapshot", () => {
    saveCachedSessions("claudecode", [makeSession("existing")]);

    saveCachedSessions("claudecode", [], {}, { completeness: "partial" });

    expect(
      readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["existing"]);
  });

  it("derives restored order from session activity", () => {
    const older = { ...makeSession("older"), time_created: now - 2_000, time_updated: now - 2_000 };
    const newer = { ...makeSession("newer"), time_created: now - 1_000, time_updated: now - 1_000 };

    saveCachedSessions("claudecode", [older, newer]);

    expect(
      readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["newer", "older"]);
  });

  it("does not rewrite retained sort indexes for a partial snapshot", () => {
    const retained = [makeSession("one"), makeSession("two"), makeSession("three")];
    saveCachedSessions("claudecode", retained);
    const db = new Database(getCachePath());
    try {
      db.exec(`
        CREATE TABLE sort_index_updates (count INTEGER NOT NULL);
        INSERT INTO sort_index_updates(count) VALUES (0);
        CREATE TRIGGER count_sort_index_updates
        AFTER UPDATE OF sort_index ON sessions
        BEGIN
          UPDATE sort_index_updates SET count = count + 1;
        END;
      `);
    } finally {
      db.close();
    }

    saveCachedSessions("claudecode", [retained[0]!], {}, { completeness: "partial" });

    const auditDb = new Database(getCachePath(), { readonly: true });
    try {
      const row = auditDb.prepare("SELECT count FROM sort_index_updates").get() as {
        count: number;
      };
      expect(row.count).toBe(1);
    } finally {
      auditDb.close();
    }
  });

  it("uses the activity-order index without a temporary sort", () => {
    saveCachedSessions("claudecode", [makeSession("one")]);
    const db = new Database(getCachePath(), { readonly: true });
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT session_id
           FROM sessions
           WHERE agent_name = ? AND publication_id IS NULL
           ORDER BY activity_time DESC, session_id`,
        )
        .all("claudecode") as Array<{ detail: string }>;
      const details = plan.map(({ detail }) => detail).join("\n");
      expect(details).toContain("idx_sessions_agent_activity_order");
      expect(details).not.toContain("USE TEMP B-TREE");
    } finally {
      db.close();
    }
  });

  it("preserves other agents", () => {
    saveCachedSessions("cursor", [makeSession("cursor-1", "cursor")]);
    saveCachedSessions("claudecode", [makeSession("claude-1")]);

    expect(
      readCachedValue("cursor")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["cursor-1"]);
    expect(
      readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["claude-1"]);
  });

  it("removes legacy json cache file after sqlite write", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getLegacyCachePath(), JSON.stringify({ stale: true }), "utf-8");

    saveCachedSessions("claudecode", [makeSession("s1")]);

    expect(() => readFileSync(getLegacyCachePath(), "utf-8")).toThrow();
  });

  it("writes project groups from cached sessions", () => {
    const claude = {
      ...makeSession("claude-1"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
      },
    };
    const codex = {
      ...makeSession("codex-1", "codex"),
      project_identity: claude.project_identity,
    };

    saveCachedSessions("claudecode", [claude]);
    saveCachedSessions("codex", [codex]);

    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "git_remote",
        identityKey: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: now,
      },
    ]);
  });

  it("reads project groups from structured sessions", () => {
    const session = {
      ...makeSession("s1"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
      },
    };

    saveCachedSessions("claudecode", [session]);

    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "git_remote",
        identityKey: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
        sources: ["claudecode"],
        sessionCount: 1,
        lastActivity: now,
      },
    ]);
  });

  it("migrates legacy sqlite cache rows to the current schema", () => {
    createLegacyCachedSessionDb(3);

    const result = readCachedValue("claudecode");

    expect(result?.sessions.map((session) => session.reference.sessionId)).toEqual(["legacy"]);
    expect(getUserVersion(getCachePath())).toBe(CACHE_SCHEMA_VERSION);
    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "path",
        identityKey: FIXTURE_DIR,
        displayName: FIXTURE_DIR_NAME,
        sources: ["claudecode"],
        sessionCount: 1,
        lastActivity: now,
      },
    ]);
  });

  it("resolves legacy identities before schema migrations begin", () => {
    clearIdentityCache();
    createLegacyCachedSessionDb(3, {
      ...makeSession("legacy-without-identity"),
      project_identity: undefined,
    });
    const events: string[] = [];
    const originalExists = realFs.exists.bind(realFs);
    const existsSpy = vi.spyOn(realFs, "exists").mockImplementation((path) => {
      events.push("identity");
      return originalExists(path);
    });
    setCoreDiagnostics({
      info(event) {
        if (event === "sqlite.migration.started") events.push("migration");
      },
      warn() {},
    });

    try {
      expect(
        readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
      ).toEqual(["legacy-without-identity"]);
      expect(events.indexOf("identity")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("identity")).toBeLessThan(events.indexOf("migration"));
    } finally {
      existsSpy.mockRestore();
      clearIdentityCache();
    }
  });

  it("skips a malformed legacy session without aborting migration", () => {
    createLegacyCachedSessionDb(3, {
      ...makeSession("legacy-null-directory"),
      directory: null as never,
      project_identity: undefined,
    });
    const warnings: Array<{ event: string; detail: unknown }> = [];
    setCoreDiagnostics({
      info() {},
      warn(event, detail) {
        warnings.push({ event, detail });
      },
    });

    try {
      expect(readCachedValue("claudecode")?.sessions).toEqual([]);
      expect(getUserVersion(getCachePath())).toBe(CACHE_SCHEMA_VERSION);
      expect(warnings).toContainEqual({
        event: "sqlite.migration.identity_precompute.missing_directory",
        detail: { agent_name: "claudecode", session_id: "legacy-null-directory" },
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("backs up populated cache before destructive migration", () => {
    createLegacyCachedSessionDb(2);

    expect(
      readCachedValue("claudecode")?.sessions.map((session) => session.reference.sessionId),
    ).toEqual(["legacy"]);

    const backups = getMigrationBackups();
    expect(backups).toHaveLength(1);

    const backupName = backups[0];
    expect(backupName).toBeDefined();
    const backupDb = new Database(join(getCacheDir(), backupName as string), { readonly: true });
    try {
      const row = backupDb.prepare("SELECT COUNT(*) AS value FROM cached_sessions").get() as {
        value?: number;
      };
      expect(Number(row.value ?? 0)).toBe(1);
    } finally {
      backupDb.close();
    }
  });

  it("skips destructive migration backup when cache tables are empty", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    const db = new Database(getCachePath());
    try {
      createLegacyCacheTables(db);
      db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', '2')").run();
    } finally {
      db.close();
    }

    expect(readCachedValue("claudecode")).toBeNull();
    expect(getMigrationBackups()).toEqual([]);
  });
});

describe("session removal", () => {
  it.each([
    {
      name: "complete snapshot",
      remove: () => saveCachedSessions("claudecode", []),
    },
    {
      name: "incremental changes",
      remove: () => saveCachedSessionChanges("claudecode", [], ["removed"]),
    },
  ])("removes every session-owned row through $name", ({ remove }) => {
    seedSessionOwnedRows();

    expect(remove()).toBe(true);

    expect(sessionOwnedDataTableCounts()).toEqual(
      Object.fromEntries(SESSION_OWNED_DATA_TABLES.map((table) => [table, 0])),
    );
  });
});

describe("saveCachedSessionChanges", () => {
  it("advances the cache timestamp for a successful no-op refresh", () => {
    saveCachedSessions("claudecode", [makeSession("unchanged")]);
    expect(readCachedValue("claudecode")?.timestamp).toBe(now);

    dateNowSpy.mockReturnValue(now + 1_000);
    expect(saveCachedSessionChanges("claudecode", [], [])).toBe(true);
    expect(readCachedValue("claudecode")?.timestamp).toBe(now + 1_000);
  });

  it("updates changed sessions and removes deleted sessions", () => {
    const unchanged = makeSession("unchanged");
    const changed = makeSession("changed");
    const removed = makeSession("removed");

    saveCachedSessions("claudecode", [unchanged, changed, removed], {
      unchanged: { id: "unchanged", sourcePath: "/tmp/unchanged" },
      changed: { id: "changed", sourcePath: "/tmp/changed-old" },
      removed: { id: "removed", sourcePath: "/tmp/removed" },
    });

    const updated = {
      ...changed,
      title: "Changed updated",
      time_updated: now + 1_000,
    };

    saveCachedSessionChanges("claudecode", [{ session: updated, sortIndex: 0 }], ["removed"], {
      changed: { id: "changed", sourcePath: "/tmp/changed-new" },
    });

    const cached = readCachedValue("claudecode");
    expect(cached?.sessions.map((session) => session.reference.sessionId)).toEqual([
      "changed",
      "unchanged",
    ]);
    expect(cached?.sessions[0]?.title).toBe("Changed updated");
    expect(cached?.meta.changed?.sourcePath).toBe("/tmp/changed-new");
    expect(cached?.meta.unchanged?.sourcePath).toBe("/tmp/unchanged");
    expect(cached?.meta.removed).toBeUndefined();

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS value FROM sessions WHERE session_id = ?")
        .get("removed") as { value?: number };
      expect(Number(row.value ?? 0)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("clearCache", () => {
  it("clears sqlite rows", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    const connection = withCacheDb((db) => db);
    clearCache();
    const reopened = withCacheDb((db) => db);

    expect(reopened).not.toBe(connection);
    expect(readCachedValue("claudecode")).toBeNull();
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("removes legacy json cache file", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getLegacyCachePath(), JSON.stringify({ stale: true }), "utf-8");
    clearCache();
    expect(() => readFileSync(getLegacyCachePath(), "utf-8")).toThrow();
  });

  it("CS-259: clears every cache-owned data table and stale metadata", () => {
    const session = makeSession("clear-me", "codex");
    expect(saveCachedSessions("codex", [session])).toBe(true);
    withCacheDb((db) => {
      db.exec(`
        INSERT INTO cache_initialization(agent_name, initialized_at, index_version, last_sync_at)
        VALUES ('codex', ${now}, 'index-v1', ${now});
        INSERT INTO pending_reindex(agent_name, session_id) VALUES ('orphan', 'clear-me');
        INSERT INTO session_documents(
          agent_name, session_id, title, content_text, content_hash,
          indexed_message_count, detail_version, indexed_at
        ) VALUES ('codex', 'clear-me', 'title', 'content', 'hash', 1, 'detail-v1', ${now});
        INSERT INTO session_file_activity(
          agent_name, session_id, project_identity_key, path, kind, count, latest_time
        ) VALUES ('codex', 'clear-me', '${FIXTURE_DIR}', 'src/index.ts', 'write', 1, ${now});
        INSERT INTO messages(
          agent_name, session_id, message_index, message_id, role, time_created, parts_json, content_text
        ) VALUES ('codex', 'clear-me', 0, 'message-1', 'assistant', ${now}, '[]', 'content');
        INSERT INTO message_tools(agent_name, session_id, message_index, tool_name)
        VALUES ('codex', 'clear-me', 0, 'write');
        INSERT INTO cache_meta(key, value) VALUES ('stale_migration_marker', '1');
      `);
    });

    clearCache();

    const cleared = new Database(getCachePath(), { readonly: true });
    try {
      expect(cacheDataTableCounts(cleared)).toEqual(emptyCacheDataTableCounts());
      expect(
        cleared.prepare("SELECT value FROM cache_meta WHERE key = 'stale_migration_marker'").get(),
      ).toBeUndefined();
      expect(cleared.prepare("SELECT key, value FROM cache_meta ORDER BY key").all()).toEqual([
        { key: "analytics_revision", value: "2" },
      ]);
      expect(Number(cleared.pragma("user_version", { simple: true }))).toBe(CACHE_SCHEMA_VERSION);
    } finally {
      cleared.close();
    }

    const reopenedMetadata = withCacheDb((db) =>
      db.prepare("SELECT key, value FROM cache_meta ORDER BY key").all(),
    );
    expect(reopenedMetadata).toEqual([
      { key: "analytics_revision", value: "2" },
      { key: "codex_exec_decode_migrated_v3", value: "1" },
      { key: "opencode_subagent_fold_v1", value: "1" },
      { key: "subagent_tree_v1", value: "1" },
      { key: "version", value: String(CACHE_SCHEMA_VERSION) },
    ]);

    clearCache();

    const clearedAgain = new Database(getCachePath(), { readonly: true });
    try {
      expect(cacheDataTableCounts(clearedAgain)).toEqual(emptyCacheDataTableCounts());
      expect(clearedAgain.prepare("SELECT key, value FROM cache_meta ORDER BY key").all()).toEqual([
        { key: "analytics_revision", value: "3" },
      ]);
    } finally {
      clearedAgain.close();
    }
  });
});

describe("cache initialization tracking", () => {
  it("distinguishes cache-state read failures from uninitialized values", () => {
    markAgentCacheInitialized("claudecode");
    withCacheDb((db) => {
      db.exec(`
        DROP TABLE cache_initialization;
        CREATE VIEW cache_initialization AS
          SELECT
            'claudecode' AS agent_name,
            missing_cache_state() AS index_version,
            1 AS last_sync_at;
      `);
    });
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      warn: (event, detail) => events.push({ event, detail }),
    });

    expect(readAgentCacheInitialization("claudecode")).toEqual({ status: "failed" });
    expect(readAgentLastFullSyncAt("claudecode")).toEqual({ status: "failed" });
    expect(events.filter(({ event }) => event === "cache.read_failed")).toHaveLength(2);
  });

  it("is not initialized and has no full-sync timestamp before any write", () => {
    expect(isAgentCacheInitialized("claudecode")).toBe(false);
    expect(getAgentLastFullSyncAt("claudecode")).toBeNull();
  });

  it("marks the cache initialized without advancing last full sync", () => {
    markAgentCacheInitialized("claudecode");

    expect(isAgentCacheInitialized("claudecode")).toBe(true);
    expect(getAgentLastFullSyncAt("claudecode")).toBeNull();
  });

  it("advances last full sync only once markAgentFullSyncCompleted runs", () => {
    markAgentCacheInitialized("claudecode");
    markAgentFullSyncCompleted("claudecode");

    expect(getAgentLastFullSyncAt("claudecode")).toBe(now);
  });

  it("CS-271: plans the unfiltered recent-session query from the activity index", () => {
    markAgentCacheInitialized("claudecode");

    const plan = withCacheDb((db) =>
      db
        .prepare(
          `
            EXPLAIN QUERY PLAN
            SELECT * FROM sessions s
            WHERE s.publication_id IS NULL
            ORDER BY s.activity_time DESC
            LIMIT ?
          `,
        )
        .all(50),
    ) as Array<{ detail: string }>;

    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_sessions_activity");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("distinguishes cached-session read failures from an empty cache", () => {
    const emptyCache = readCachedSessions("claudecode");
    expect(emptyCache).toEqual({ status: "success", value: null });

    markAgentCacheInitialized("claudecode");
    withCacheDb((db) => {
      db.exec(`
        DROP TABLE agent_cache;
        CREATE VIEW agent_cache AS
          SELECT 'claudecode' AS agent_name, missing_cache_state() AS timestamp;
      `);
    });
    const events: Array<{ event: string }> = [];
    setCoreDiagnostics({ warn: (event) => events.push({ event }) });

    expect(readCachedSessions("claudecode")).toEqual({ status: "failed" });
    setCoreDiagnostics(null);
  });

  it("reports a full-sync cursor write that never reached disk", () => {
    markAgentCacheInitialized("claudecode");
    expect(markAgentFullSyncProgress("claudecode", "session-1")).toBe(true);

    withCacheDb((db) => {
      db.exec(`
        DROP TABLE cache_meta;
        CREATE VIEW cache_meta AS SELECT missing_cache_state() AS key, '' AS value;
      `);
    });
    const events: Array<{ event: string }> = [];
    setCoreDiagnostics({ warn: (event) => events.push({ event }) });

    expect(markAgentFullSyncProgress("claudecode", "session-2")).toBe(false);
    setCoreDiagnostics(null);
  });

  it("records full-sync completion even without a prior initialization row", () => {
    markAgentFullSyncCompleted("claudecode");

    expect(getAgentLastFullSyncAt("claudecode")).toBe(now);
    expect(isAgentCacheInitialized("claudecode")).toBe(true);
  });

  it("keeps a full-sync marker pending until reconciliation completes", () => {
    markAgentCacheInitialized("claudecode");
    markAgentFullSyncCompleted("claudecode");

    markAgentFullSyncStarted("claudecode");

    expect(getAgentLastFullSyncAt("claudecode")).toBeNull();
  });

  it("persists an incomplete full-sync cursor and clears it on completion", () => {
    markAgentCacheInitialized("claudecode");
    markAgentFullSyncProgress("claudecode", "session-200");

    expect(getAgentFullSyncCursor("claudecode")).toBe("session-200");

    markAgentFullSyncCompleted("claudecode");

    expect(getAgentFullSyncCursor("claudecode")).toBeNull();
  });

  it("re-initializing an already-synced agent preserves its last full sync", () => {
    markAgentCacheInitialized("claudecode");
    markAgentFullSyncCompleted("claudecode");

    dateNowSpy.mockReturnValue(now + 1000);
    markAgentCacheInitialized("claudecode");

    expect(getAgentLastFullSyncAt("claudecode")).toBe(now);
  });
});

describe("getCacheInfo", () => {
  it("returns defaults when cache db does not exist", () => {
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("returns aggregate info from sqlite cache", () => {
    saveCachedSessions("agent1", [makeSession("a", "agent1"), makeSession("b", "agent1")]);
    saveCachedSessions("agent2", [makeSession("c", "agent2")]);

    expect(getCacheInfo()).toEqual({ lastScanTime: now, size: 3 });
  });
});
