import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getAgentLastFullSyncAt,
  getCacheInfo,
  isAgentCacheInitialized,
  listCachedProjectGroups,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncCompleted,
  saveCachedSessionChanges,
  saveCachedSessions,
  type SessionCacheMeta,
} from "../../cache.js";
import { ensureFtsConsistency, withCacheDb } from "../schema.js";
import {
  getFtsIntegrityCheckedPath,
  getSchemaEnsuredPath,
  setFtsIntegrityCheckedPath,
  setSchemaEnsuredPath,
} from "../db.js";
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

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), "scan-cache.json");
}

// Isolated temp directory for session fixtures so computeIdentity always
// resolves to a "path" identity regardless of what manifests exist in /tmp.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-identity-"));
const FIXTURE_DIR_NAME = FIXTURE_DIR.split(/[\\/]/).pop()!;

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: FIXTURE_DIR,
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
    ).run("claudecode", session.id, JSON.stringify(session), null);
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

beforeEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  dateNowSpy.mockReturnValue(now);
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

afterEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});
describe("loadCachedSessions", () => {
  it("returns null when cache db does not exist", () => {
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when agent is not cached", () => {
    saveCachedSessions("cursor", [makeSession("s1")]);
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns cached sessions even when last refresh is old", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    dateNowSpy.mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    expect(loadCachedSessions("claudecode")?.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("returns cached sessions and meta when valid", () => {
    const meta: Record<string, SessionCacheMeta> = {
      s1: { id: "s1", sourcePath: "/path/to/source" },
    };

    saveCachedSessions("claudecode", [makeSession("s1")], meta);

    const result = loadCachedSessions("claudecode");
    expect(result).not.toBeNull();
    expect(result?.sessions).toHaveLength(1);
    expect(result?.sessions[0]?.id).toBe("s1");
    expect(result?.meta.s1?.sourcePath).toBe("/path/to/source");
    expect(result?.timestamp).toBe(now);
  });

  it("preserves empty cached results", () => {
    saveCachedSessions("claudecode", []);
    const result = loadCachedSessions("claudecode");
    expect(result).toEqual({
      sessions: [],
      meta: {},
      timestamp: now,
    });
  });
});

describe("ensureFtsConsistency", () => {
  it("runs the FTS integrity check once per cache path and marks it checked", () => {
    withCacheDb((db) => {
      const execSpy = vi.spyOn(db, "exec");
      ensureFtsConsistency(db);
      expect(execSpy.mock.calls.some((call) => String(call[0]).includes("integrity-check"))).toBe(
        true,
      );
      expect(getFtsIntegrityCheckedPath()).toBe(getCachePath());
    });
  });

  it("skips the integrity check when the cache path is already marked checked", () => {
    withCacheDb((db) => {
      setFtsIntegrityCheckedPath(getCachePath());
      const execSpy = vi.spyOn(db, "exec");
      ensureFtsConsistency(db);
      expect(execSpy.mock.calls.some((call) => String(call[0]).includes("integrity-check"))).toBe(
        false,
      );
    });
  });
});

describe("withCacheDb schema memo", () => {
  it("runs ensureSchema on the first open but skips it on later opens for the same path", () => {
    withCacheDb(() => undefined);
    expect(getSchemaEnsuredPath()).toBe(getCachePath());
    expect(getUserVersion(getCachePath())).toBe(14);

    const db = new Database(getCachePath());
    db.pragma("user_version = 5");
    db.close();

    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(5);

    setSchemaEnsuredPath(null);
    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(14);
  });
});

describe("saveCachedSessions", () => {
  it("creates sqlite cache db", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(readFileSync(getCachePath()).byteLength).toBeGreaterThan(0);
    expect(getUserVersion(getCachePath())).toBe(14);
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
      smart_tags: ["feature-dev" as const],
      smart_tags_source_updated_at: now,
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
      };

      expect(row.session_id).toBe("s1");
      expect(row.source_path).toBe("/path/to/source");
      expect(row.message_count).toBe(3);
      expect(row.total_tokens).toBe(20);
      expect(JSON.parse(row.model_usage_json ?? "{}")).toEqual({ "claude-sonnet": 20 });
      expect(JSON.parse(row.smart_tags_json ?? "[]")).toEqual(["feature-dev"]);
    } finally {
      db.close();
    }
  });

  it("restores session heads from structured rows when snapshot json is malformed", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);

    const db = new Database(getCachePath());
    try {
      db.prepare("UPDATE cached_sessions SET session_json = ? WHERE session_id = ?").run("{", "s1");
    } finally {
      db.close();
    }

    const result = loadCachedSessions("claudecode");
    expect(result?.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("overwrites cached rows for the same agent", () => {
    saveCachedSessions("claudecode", [makeSession("old")]);
    saveCachedSessions("claudecode", [makeSession("new")]);

    const result = loadCachedSessions("claudecode");
    expect(result?.sessions.map((session) => session.id)).toEqual(["new"]);
  });

  it("preserves other agents", () => {
    saveCachedSessions("cursor", [makeSession("cursor-1")]);
    saveCachedSessions("claudecode", [makeSession("claude-1")]);

    expect(loadCachedSessions("cursor")?.sessions.map((session) => session.id)).toEqual([
      "cursor-1",
    ]);
    expect(loadCachedSessions("claudecode")?.sessions.map((session) => session.id)).toEqual([
      "claude-1",
    ]);
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
      slug: "claudecode/claude-1",
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
      },
    };
    const codex = {
      ...makeSession("codex-1"),
      slug: "codex/codex-1",
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
      slug: "claudecode/s1",
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
      },
    };

    saveCachedSessions("claudecode", [session]);

    const db = new Database(getCachePath());
    try {
      db.prepare("DELETE FROM project_sessions").run();
    } finally {
      db.close();
    }

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

    const result = loadCachedSessions("claudecode");

    expect(result?.sessions.map((session) => session.id)).toEqual(["legacy"]);
    expect(getUserVersion(getCachePath())).toBe(14);
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

  it("backs up populated cache before destructive migration", () => {
    createLegacyCachedSessionDb(2);

    expect(loadCachedSessions("claudecode")?.sessions.map((session) => session.id)).toEqual([
      "legacy",
    ]);

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

    expect(loadCachedSessions("claudecode")).toBeNull();
    expect(getMigrationBackups()).toEqual([]);
  });
});

describe("saveCachedSessionChanges", () => {
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

    const cached = loadCachedSessions("claudecode");
    expect(cached?.sessions.map((session) => session.id)).toEqual(["changed", "unchanged"]);
    expect(cached?.sessions[0]?.title).toBe("Changed updated");
    expect(cached?.meta.changed?.sourcePath).toBe("/tmp/changed-new");
    expect(cached?.meta.unchanged?.sourcePath).toBe("/tmp/unchanged");
    expect(cached?.meta.removed).toBeUndefined();

    const db = new Database(getCachePath(), { readonly: true });
    try {
      for (const table of ["cached_sessions", "sessions", "project_sessions"]) {
        const row = db
          .prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE session_id = ?`)
          .get("removed") as { value?: number };
        expect(Number(row.value ?? 0)).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});

describe("clearCache", () => {
  it("clears sqlite rows", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    clearCache();
    expect(loadCachedSessions("claudecode")).toBeNull();
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("removes legacy json cache file", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getLegacyCachePath(), JSON.stringify({ stale: true }), "utf-8");
    clearCache();
    expect(() => readFileSync(getLegacyCachePath(), "utf-8")).toThrow();
  });
});

describe("cache initialization tracking", () => {
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
    saveCachedSessions("agent1", [makeSession("a"), makeSession("b")]);
    saveCachedSessions("agent2", [makeSession("c")]);

    expect(getCacheInfo()).toEqual({ lastScanTime: now, size: 3 });
  });
});
