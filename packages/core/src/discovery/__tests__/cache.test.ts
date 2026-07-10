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
  listFileActivity,
  listCachedProjectGroups,
  loadCachedSessionData,
  loadCachedSessions,
  markAgentCacheInitialized,
  markAgentFullSyncCompleted,
  parseSearchQuery,
  searchFileActivitySessions,
  searchSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type SessionCacheMeta,
} from "../cache.js";
import { ensureFtsConsistency, withCacheDb } from "../cache/schema.js";
import {
  getFtsIntegrityCheckedPath,
  getSchemaEnsuredPath,
  setFtsIntegrityCheckedPath,
  setSchemaEnsuredPath,
} from "../cache/db.js";
import type { SessionData, SessionHead } from "../../types/index.js";

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

function makeSessionData(id: string, text: string): SessionData {
  const session = makeSession(id);
  return {
    ...session,
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        time_created: now,
        parts: [{ type: "text", text }],
      },
    ],
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
    expect(getUserVersion(getCachePath())).toBe(13);

    const db = new Database(getCachePath());
    db.pragma("user_version = 5");
    db.close();

    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(5);

    setSchemaEnsuredPath(null);
    withCacheDb(() => undefined);
    expect(getUserVersion(getCachePath())).toBe(13);
  });
});

describe("saveCachedSessions", () => {
  it("creates sqlite cache db", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(readFileSync(getCachePath()).byteLength).toBeGreaterThan(0);
    expect(getUserVersion(getCachePath())).toBe(13);
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
    expect(getUserVersion(getCachePath())).toBe(13);
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

describe("searchSessions", () => {
  it("parses lightweight structured search qualifiers", () => {
    expect(
      parseSearchQuery(
        'agent:codex project:"code sesh" projectkind:git_remote projectkey:github.com/acme/app tag:feature-dev tool:apply_patch file:"src/App File.tsx" cost:>1 needle',
      ),
    ).toEqual({
      text: "needle",
      filters: {
        agent: "codex",
        project: "code sesh",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        tags: ["feature-dev"],
        tools: ["apply_patch"],
        file: "src/App File.tsx",
        costMin: 1,
        costMinExclusive: true,
      },
      hasQualifiers: true,
    });
  });

  it("preserves strict cost qualifier comparisons", () => {
    const below = {
      ...makeSession("below"),
      time_updated: now + 1,
      stats: { ...makeSession("below").stats, total_cost: 0.99 },
    };
    const boundary = {
      ...makeSession("boundary"),
      time_updated: now + 2,
      stats: { ...makeSession("boundary").stats, total_cost: 1 },
    };
    const above = {
      ...makeSession("above"),
      time_updated: now + 3,
      stats: { ...makeSession("above").stats, total_cost: 1.01 },
    };

    saveCachedSessions("codex", [below, boundary, above]);

    expect(searchSessions("cost:>1").map((result) => result.session.id)).toEqual(["above"]);
    expect(searchSessions("cost:<1").map((result) => result.session.id)).toEqual(["below"]);
    expect(searchSessions("cost:>=1").map((result) => result.session.id)).toEqual([
      "above",
      "boundary",
    ]);
    expect(searchSessions("cost:<=1").map((result) => result.session.id)).toEqual([
      "boundary",
      "below",
    ]);
  });

  it("creates cache storage when syncing search index first", () => {
    const session = makeSession("first-search");

    const result = syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "first search creates the sqlite cache"),
    );

    expect(result).toMatchObject({
      changed: 1,
      indexed: 1,
      skipped: 0,
    });
    expect(searchSessions("sqlite")).toHaveLength(1);
  });

  it("loads full session data from the SQLite message cache", () => {
    const session: SessionHead = {
      ...makeSession("cached-detail"),
      stats: {
        message_count: 1,
        total_input_tokens: 3,
        total_output_tokens: 5,
        total_cost: 0.02,
        cost_source: "estimated" as const,
      },
    };
    syncSessionSearchIndex("codex", [session], (sessionId) => ({
      ...makeSessionData(sessionId, "detail view reads sqlite"),
      messages: [
        {
          id: "m1",
          role: "assistant",
          time_created: now,
          tokens: { input: 3, output: 5 },
          cost: 0.02,
          cost_source: "estimated",
          parts: [{ type: "text", text: "detail view reads sqlite" }],
        },
      ],
    }));

    const data = loadCachedSessionData("codex", "cached-detail");

    expect(data).toMatchObject({
      id: "cached-detail",
      title: "Session cached-detail",
      stats: {
        message_count: 1,
        total_input_tokens: 3,
        total_output_tokens: 5,
        total_cost: 0.02,
        cost_source: "estimated",
      },
      messages: [
        {
          id: "m1",
          role: "assistant",
          tokens: { input: 3, output: 5 },
          cost: 0.02,
          cost_source: "estimated",
          parts: [{ type: "text", text: "detail view reads sqlite" }],
        },
      ],
    });
  });

  it("indexes session content and returns highlighted matches", () => {
    const session = {
      ...makeSession("s1"),
      stats: {
        message_count: 1,
        total_input_tokens: 11,
        total_output_tokens: 7,
        total_cost: 0.03,
      },
    };
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "sqlite fts search is now enabled"),
    );

    const results = searchSessions("sqlite");
    expect(results).toHaveLength(1);
    expect(results[0]?.agentName).toBe("claudecode");
    expect(results[0]?.session.id).toBe("s1");
    expect(results[0]?.session.stats).toMatchObject({
      message_count: 1,
      total_input_tokens: 11,
      total_output_tokens: 7,
      total_cost: 0.03,
    });
    expect(results[0]?.snippet).toContain("<mark>sqlite</mark>");
  });

  it("filters indexed search by complete project identity", () => {
    const remote = {
      ...makeSession("remote"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/acme/app",
        displayName: "app",
      },
    };
    const path = {
      ...makeSession("path"),
      project_identity: {
        kind: "path" as const,
        key: "github.com/acme/app",
        displayName: "app path",
      },
    };
    const sessions = [remote, path];
    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessions.find((session) => session.id === sessionId)!,
      messages: makeSessionData(sessionId, "identity collision needle").messages,
    }));

    expect(
      searchSessions("collision", {
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      }).map((result) => result.session.id),
    ).toEqual(["remote"]);
    expect(searchSessions("collision", { projectKey: "github.com/acme/app" })).toEqual([]);
  });

  it("resolves search match metadata from message-level FTS", () => {
    const title = {
      ...makeSession("title"),
      title: "titleonly search title",
    };
    const user = makeSession("user");
    const assistant = makeSession("assistant");
    const tool = makeSession("tool");
    const quoted = makeSession("quoted");
    const orFirst = {
      ...makeSession("or-first"),
      stats: { ...makeSession("or-first").stats, message_count: 2 },
    };
    const sessions = [title, user, assistant, tool, quoted, orFirst];
    const dataById = new Map<string, SessionData>([
      [
        "title",
        {
          ...title,
          messages: [
            {
              id: "title-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "body without the title token" }],
            },
          ],
        },
      ],
      [
        "user",
        {
          ...user,
          messages: [
            {
              id: "user-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "userneedle request" }],
            },
          ],
        },
      ],
      [
        "assistant",
        {
          ...assistant,
          messages: [
            {
              id: "assistant-m1",
              role: "assistant",
              time_created: now,
              parts: [{ type: "text", text: "assistantneedle reply" }],
            },
          ],
        },
      ],
      [
        "tool",
        {
          ...tool,
          messages: [
            {
              id: "tool-m1",
              role: "assistant",
              mode: "tool",
              time_created: now,
              parts: [
                {
                  type: "tool",
                  tool: "bash",
                  state: { status: "completed", output: "toolneedle output" },
                },
              ],
            },
          ],
        },
      ],
      [
        "quoted",
        {
          ...quoted,
          messages: [
            {
              id: "quoted-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "exact quoted phrase marker" }],
            },
          ],
        },
      ],
      [
        "or-first",
        {
          ...orFirst,
          messages: [
            {
              id: "or-first-m1",
              role: "assistant",
              time_created: now,
              parts: [{ type: "text", text: "betaneedle first" }],
            },
            {
              id: "or-first-m2",
              role: "user",
              time_created: now + 1,
              parts: [{ type: "text", text: "alphaneedle second" }],
            },
          ],
        },
      ],
    ]);

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => dataById.get(sessionId)!);

    expect(searchSessions("titleonly")[0]?.matchType).toBe("title");
    expect(searchSessions("userneedle")[0]?.matchType).toBe("user_message");
    expect(searchSessions("assistantneedle")[0]?.matchType).toBe("assistant_reply");
    expect(searchSessions("toolneedle")[0]?.matchType).toBe("tool_output");
    expect(searchSessions('"quoted phrase"')[0]?.snippet).toContain("<mark>quoted phrase</mark>");

    const orResults = searchSessions("alphaneedle OR betaneedle");
    expect(orResults[0]?.session.id).toBe("or-first");
    expect(orResults[0]?.matchType).toBe("assistant_reply");
    expect(orResults[0]?.snippet).toContain("<mark>betaneedle</mark>");
  });

  it("uses a single message FTS lookup for result match metadata", () => {
    const sessions = Array.from({ length: 3 }, (_, sessionIndex) => ({
      ...makeSession(`bulk-match-${sessionIndex}`),
      stats: { ...makeSession(`bulk-match-${sessionIndex}`).stats, message_count: 30 },
    }));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessions.find((session) => session.id === sessionId)!,
      messages: Array.from({ length: 30 }, (_, messageIndex) => ({
        id: `${sessionId}-m${messageIndex}`,
        role: "user" as const,
        time_created: now + messageIndex,
        parts: [
          {
            type: "text" as const,
            text: messageIndex === 29 ? `bulkneedle ${sessionId}` : `filler ${messageIndex}`,
          },
        ],
      })),
    }));

    const preparedSql: string[] = [];
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      preparedSql.push(source);
      return originalPrepare.call(this, source);
    });

    try {
      expect(searchSessions("bulkneedle")).toHaveLength(3);
    } finally {
      prepareSpy.mockRestore();
    }

    const normalizedSql = preparedSql.map((sql) => sql.replace(/\s+/g, " ").trim());
    expect(normalizedSql.filter((sql) => sql.includes("FROM messages_fts"))).toHaveLength(1);
    expect(
      normalizedSql.some((sql) =>
        /FROM messages WHERE agent_name = \? AND session_id = \? ORDER BY message_index/.test(sql),
      ),
    ).toBe(false);
  });

  it("bulk sync rebuilds FTS for large initial indexes", () => {
    const sessions = Array.from({ length: 101 }, (_, index) => {
      const session = makeSession(`bulk-${index}`);
      if (index === 42) {
        return {
          ...session,
          directory: "/tmp/bulk-project",
          project_identity: {
            kind: "path" as const,
            key: "/tmp/bulk-project",
            displayName: "bulk-project",
          },
        };
      }
      if (index === 43) {
        return {
          ...session,
          directory: "/tmp/other-project",
          project_identity: {
            kind: "path" as const,
            key: "/tmp/other-project",
            displayName: "other-project",
          },
        };
      }
      return session;
    });
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    const result = syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessionMap.get(sessionId)!,
      messages: [
        {
          id: `${sessionId}-m1`,
          role: "user",
          time_created: now,
          parts: [
            {
              type: "text",
              text:
                sessionId === "bulk-42" || sessionId === "bulk-43"
                  ? "bulk needle project filter"
                  : `bulk filler ${sessionId}`,
            },
          ],
        },
      ],
    }));

    expect(result).toMatchObject({
      mode: "bulk",
      sessions: 101,
      changed: 101,
      deleted: 0,
      indexed: 101,
      skipped: 0,
    });
    expect(result?.rebuildDurationMs).toBeGreaterThanOrEqual(0);

    const allResults = searchSessions("needle");
    expect(allResults).toHaveLength(2);

    const filteredResults = searchSessions("needle", { cwd: "/tmp/bulk-project" });
    expect(filteredResults).toHaveLength(1);
    expect(filteredResults[0]?.session.id).toBe("bulk-42");
    expect(filteredResults[0]?.snippet).toContain("<mark>needle</mark>");
  });

  it("keeps small incremental updates searchable immediately", () => {
    const session = makeSession("small");
    const updated = {
      ...session,
      stats: { ...session.stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "old search content"),
    );

    saveCachedSessions("claudecode", [updated]);
    const result = syncSessionSearchIndex("claudecode", [updated], () => ({
      ...updated,
      messages: [
        {
          id: "small-m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "old search content" }],
        },
        {
          id: "small-m2",
          role: "assistant",
          time_created: now + 1,
          parts: [{ type: "text", text: "instant incremental token" }],
        },
      ],
    }));

    expect(result).toMatchObject({
      mode: "incremental",
      changed: 1,
      indexed: 1,
      deleted: 0,
    });
    expect(result?.rebuildDurationMs).toBeUndefined();
    expect(searchSessions("instant")).toHaveLength(1);
  });

  it("syncs changed search rows without diffing untouched sessions", () => {
    const keep = {
      ...makeSession("keep"),
      stats: { ...makeSession("keep").stats, message_count: 2 },
    };
    const changed = {
      ...makeSession("changed"),
      stats: { ...makeSession("changed").stats, message_count: 2 },
    };
    const removed = {
      ...makeSession("removed"),
      stats: { ...makeSession("removed").stats, message_count: 2 },
    };
    const sessions = [keep, changed, removed];
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const makeIndexedData = (session: SessionHead, text: string, path: string): SessionData => ({
      ...session,
      messages: [
        {
          id: `${session.id}-m1`,
          role: "user",
          time_created: now,
          parts: [{ type: "text", text }],
        },
        {
          id: `${session.id}-m2`,
          role: "assistant",
          time_created: now + 1,
          parts: [{ type: "tool", tool: "read", input: { path } }],
        },
      ],
    });

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) =>
      makeIndexedData(sessionMap.get(sessionId)!, `${sessionId}token`, `src/${sessionId}.ts`),
    );

    const updated = {
      ...changed,
      title: "Changed updated",
      stats: { ...changed.stats, message_count: 2 },
    };
    const loadChanged = vi.fn((sessionId: string) => {
      if (sessionId !== "changed") {
        throw new Error(`unexpected load ${sessionId}`);
      }
      return makeIndexedData(updated, "updatedtoken", "src/changed-new.ts");
    });

    saveCachedSessionChanges("claudecode", [{ session: updated, sortIndex: 0 }], ["removed"]);
    const result = syncSessionSearchIndexChanges(
      "claudecode",
      [{ session: updated, sortIndex: 0 }],
      ["removed"],
      loadChanged,
    );

    expect(loadChanged).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "incremental",
      changed: 1,
      deleted: 1,
      indexed: 1,
    });
    expect(searchSessions("updatedtoken").map((item) => item.session.id)).toEqual(["changed"]);
    expect(searchSessions("changedtoken")).toHaveLength(0);
    expect(searchSessions("removedtoken")).toHaveLength(0);
    expect(searchSessions("keeptoken").map((item) => item.session.id)).toEqual(["keep"]);
    expect(
      listFileActivity({ agent: "claudecode" })
        .map((item) => item.path)
        .sort(),
    ).toEqual(["src/changed-new.ts", "src/keep.ts"]);
  });

  it("reads incremental search index state in bounded batches", () => {
    const sessions = Array.from({ length: 1_000 }, (_, index) => makeSession(`batch-${index}`));
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) =>
      makeSessionData(sessionMap.get(sessionId)!.id, `content ${sessionId}`),
    );

    let stateQueryExecutions = 0;
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      const statement = originalPrepare.call(this, source);
      const normalized = source.replace(/\s+/g, " ").trim();
      const isStateQuery =
        normalized.startsWith("SELECT content_hash FROM session_documents") ||
        normalized.startsWith("SELECT COUNT(*) AS value FROM messages") ||
        normalized.startsWith("WITH requested_session_ids");
      if (!isStateQuery) {
        return statement;
      }

      const originalGet = statement.get.bind(statement);
      statement.get = (...params: unknown[]) => {
        stateQueryExecutions += 1;
        return (originalGet as (...boundParams: unknown[]) => unknown)(...params);
      };
      const originalAll = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        stateQueryExecutions += 1;
        return (originalAll as (...boundParams: unknown[]) => unknown[])(...params);
      };
      return statement;
    });

    const batchExecutions: number[] = [];
    try {
      for (const changeCount of [10, 100, 1_000]) {
        const executionsBeforeSync = stateQueryExecutions;
        const result = syncSessionSearchIndexChanges(
          "claudecode",
          sessions.slice(0, changeCount).map((session, sortIndex) => ({ session, sortIndex })),
          [],
          () => {
            throw new Error("unchanged sessions must not be loaded");
          },
        );
        expect(result?.changed).toBe(0);
        batchExecutions.push(stateQueryExecutions - executionsBeforeSync);
      }
    } finally {
      prepareSpy.mockRestore();
    }

    expect(batchExecutions).toEqual([1, 1, 2]);
  });

  it("preserves incremental state defaults and duplicate change semantics", () => {
    const missingDocument = makeSession("missing-document");
    const missingMessages = makeSession("missing-messages");
    const zeroMessages = {
      ...makeSession("zero-messages"),
      stats: { ...makeSession("zero-messages").stats, message_count: 0 },
    };
    const sessions = [missingDocument, missingMessages, zeroMessages];
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessionMap.get(sessionId)!,
      messages: sessionId === zeroMessages.id ? [] : makeSessionData(sessionId, sessionId).messages,
    }));

    const db = new Database(getCachePath());
    try {
      db.prepare("DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?").run(
        "claudecode",
        missingDocument.id,
      );
      db.prepare("DELETE FROM messages WHERE agent_name = ? AND session_id = ?").run(
        "claudecode",
        missingMessages.id,
      );
    } finally {
      db.close();
    }

    const loadSession = vi.fn((sessionId: string) =>
      makeSessionData(sessionId, `reindexed ${sessionId}`),
    );
    const result = syncSessionSearchIndexChanges(
      "claudecode",
      [
        { session: missingDocument, sortIndex: 0 },
        { session: missingMessages, sortIndex: 1 },
        { session: missingMessages, sortIndex: 1 },
        { session: zeroMessages, sortIndex: 2 },
      ],
      [],
      loadSession,
    );

    expect(result).toMatchObject({
      sessions: 4,
      changed: 3,
      indexed: 3,
      skipped: 0,
    });
    expect(loadSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      missingDocument.id,
      missingMessages.id,
      missingMessages.id,
    ]);
  });

  it("restores missing FTS triggers before incremental sync", () => {
    const session = makeSession("trigger");
    const updated = {
      ...session,
      title: "Updated trigger",
      stats: { ...session.stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "old trigger content"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec(`
        DROP TRIGGER session_documents_ai;
        DROP TRIGGER session_documents_ad;
        DROP TRIGGER session_documents_au;
      `);
    } finally {
      db.close();
    }

    saveCachedSessions("claudecode", [updated]);
    syncSessionSearchIndex("claudecode", [updated], () => ({
      ...updated,
      messages: [
        {
          id: "trigger-m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "old trigger content" }],
        },
        {
          id: "trigger-m2",
          role: "assistant",
          time_created: now + 1,
          parts: [{ type: "text", text: "healed trigger content" }],
        },
      ],
    }));

    const triggerDb = new Database(getCachePath(), { readonly: true });
    try {
      const row = triggerDb
        .prepare(
          "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_documents_%'",
        )
        .get() as { value?: number };
      expect(row.value).toBe(3);
    } finally {
      triggerDb.close();
    }

    expect(searchSessions("healed")).toHaveLength(1);
  });

  it("upserts normalized message rows for indexed sessions", () => {
    const session = {
      ...makeSession("s1"),
      stats: { ...makeSession("s1").stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "first message" }],
        },
        {
          id: "m2",
          role: "assistant",
          time_created: now + 1,
          parts: [
            {
              type: "tool",
              tool: "grep",
              title: "Search",
              state: { status: "completed", output: "result" },
            },
          ],
        },
      ],
    }));

    syncSessionSearchIndex(
      "claudecode",
      [{ ...session, stats: { ...session.stats, message_count: 1 } }],
      () => ({
        ...session,
        stats: { ...session.stats, message_count: 1 },
        messages: [
          {
            id: "m1-updated",
            role: "user",
            time_created: now,
            parts: [{ type: "text", text: "updated sqlite message" }],
          },
        ],
      }),
    );

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT message_id, role, content_text, tool_metadata_json FROM messages ORDER BY message_index",
        )
        .all() as Array<{
        message_id?: string;
        role?: string;
        content_text?: string;
        tool_metadata_json?: string | null;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message_id).toBe("m1-updated");
      expect(rows[0]?.role).toBe("user");
      expect(rows[0]?.content_text).toContain("updated sqlite message");
    } finally {
      db.close();
    }

    expect(searchSessions("updated")).toHaveLength(1);
  });

  it("uses the structured tool index for tool filters", () => {
    const target = {
      ...makeSession("tool-target"),
      stats: { ...makeSession("tool-target").stats, message_count: 1 },
    };
    const other = {
      ...makeSession("tool-other"),
      stats: { ...makeSession("tool-other").stats, message_count: 1 },
    };

    saveCachedSessions("claudecode", [target, other]);
    syncSessionSearchIndex("claudecode", [target, other], (sessionId) => ({
      ...(sessionId === target.id ? target : other),
      messages: [
        {
          id: `${sessionId}-tool`,
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: sessionId === target.id ? "apply_patch" : "grep",
              state: { status: "completed" },
            },
          ],
        },
      ],
    }));

    expect(searchSessions("tool:apply_patch").map((result) => result.session.id)).toEqual([
      "tool-target",
    ]);

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT session_id, tool_name FROM message_tools ORDER BY session_id, tool_name")
        .all();
      expect(rows).toEqual([
        { session_id: "tool-other", tool_name: "grep" },
        { session_id: "tool-target", tool_name: "apply_patch" },
      ]);

      const plan = db
        .prepare(
          `
            EXPLAIN QUERY PLAN
            SELECT s.session_id
            FROM sessions s
            WHERE EXISTS (
              SELECT 1
              FROM message_tools mt
              WHERE mt.tool_name = ?
                AND mt.agent_name = s.agent_name
                AND mt.session_id = s.session_id
            )
          `,
        )
        .all("apply_patch")
        .map((row) => String((row as { detail?: unknown }).detail ?? ""))
        .join("\n");
      expect(plan).toContain("idx_message_tools_filter");
    } finally {
      db.close();
    }
  });

  it("indexes file activity from tool calls", () => {
    const session = {
      ...makeSession("files"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/acme/app",
        displayName: "app",
      },
      stats: { ...makeSession("files").stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: "Read",
              time_created: now,
              state: { input: { file_path: "src/App.tsx" } },
            },
            {
              type: "tool",
              tool: "write_file",
              time_created: now + 5,
              state: { input: { path: "src/direct.ts" } },
            },
            {
              type: "tool",
              tool: "patch",
              time_created: now + 10,
              state: {
                input: {
                  content: [
                    { type: "edit_file", path: "src/App.tsx" },
                    { type: "write_file", path: "src/new.ts" },
                    { type: "delete_file", path: "src/old.ts" },
                  ],
                },
              },
            },
          ],
        },
      ],
    }));

    expect(
      listFileActivity({
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        path: "src/App",
        limit: 10,
      }).map(({ kind, path, count }) => ({ kind, path, count })),
    ).toEqual([
      { kind: "edit", path: "src/App.tsx", count: 1 },
      { kind: "read", path: "src/App.tsx", count: 1 },
    ]);

    expect(
      listFileActivity({
        agent: "claudecode",
        sessionId: "files",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        cwd: FIXTURE_DIR,
        path: "src/App",
        kind: "edit",
        from: now + 9,
        to: now + 11,
        limit: 10,
      }).map(({ kind, path, count }) => ({ kind, path, count })),
    ).toEqual([{ kind: "edit", path: "src/App.tsx", count: 1 }]);

    const searchResults = searchFileActivitySessions("src/new.ts");
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.session.id).toBe("files");
    expect(searchResults[0]?.snippet).toContain("<mark>src/new.ts</mark>");

    const directWriteResults = searchFileActivitySessions("src/direct.ts");
    expect(directWriteResults).toHaveLength(1);
    expect(directWriteResults[0]?.snippet).toContain("write");
  });

  it("uses latest-time indexes for recent file activity query plans", () => {
    saveCachedSessions("claudecode", [makeSession("indexed")]);

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const explain = (where: string, ...params: unknown[]) =>
        (
          db
            .prepare(
              `
                EXPLAIN QUERY PLAN
                SELECT
                  fa.agent_name,
                  fa.session_id,
                  fa.project_identity_key,
                  fa.path,
                  fa.kind,
                  fa.count,
                  fa.latest_time
                FROM session_file_activity fa
                JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
                ${where}
                ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
                LIMIT ?
              `,
            )
            .all(...params, 50) as Array<{ detail?: string }>
        )
          .map((row) => String(row.detail ?? ""))
          .join("\n");

      expect(explain("")).toContain("USING INDEX idx_file_activity_latest");
      expect(explain("WHERE fa.agent_name = ?", "claudecode")).toContain(
        "USING INDEX idx_file_activity_agent_latest",
      );
      expect(explain("WHERE fa.project_identity_key = ?", "/tmp/project")).toContain(
        "USING INDEX idx_file_activity_project_latest_ordered",
      );
      const pathPlan = explain(
        "WHERE fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
        '"src/App"',
      );
      expect(pathPlan).toContain("session_file_activity_path_fts");
      expect(pathPlan).not.toContain("SCAN fa\n");
    } finally {
      db.close();
    }
  });

  it("rebuilds path search index when migrating existing file activity rows", () => {
    const session = makeSession("path-migration");

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "path-migration-tool",
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: "Read",
              state: { input: { file_path: "src/migrated/App.tsx" } },
            },
          ],
        },
      ],
    }));

    const db = new Database(getCachePath());
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS session_file_activity_path_ai;
        DROP TRIGGER IF EXISTS session_file_activity_path_ad;
        DROP TRIGGER IF EXISTS session_file_activity_path_au;
        DROP TABLE IF EXISTS session_file_activity_path_fts;
        PRAGMA user_version = 9;
      `);
      db.prepare("UPDATE cache_meta SET value = '9' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    expect(listFileActivity({ path: "migrated/App", limit: 10 }).map((item) => item.path)).toEqual([
      "src/migrated/App.tsx",
    ]);
    expect(getUserVersion(getCachePath())).toBe(13);
  });

  it("refreshes cached project identities when migrating to schema version 12", () => {
    const directory = join(testHomeDir, "Documents", "Codex", "2026-05-22", "new-chat");
    saveCachedSessions("codex", [{ ...makeSession("codex-scratch"), directory }]);

    const db = new Database(getCachePath());
    try {
      db.prepare(
        `
          UPDATE sessions
          SET project_identity_kind = 'path',
              project_identity_key = ?,
              project_display_name = 'new-chat'
        `,
      ).run(directory);
      db.prepare(
        `
          UPDATE project_sessions
          SET identity_kind = 'path',
              identity_key = ?,
              display_name = 'new-chat'
        `,
      ).run(directory);
      db.pragma("user_version = 11");
      db.prepare("UPDATE cache_meta SET value = '11' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "synthetic",
        identityKey: "codex:scratch",
        displayName: "Chats",
        sources: ["codex"],
        sessionCount: 1,
        lastActivity: now,
      },
    ]);
    expect(loadCachedSessions("codex")?.sessions[0]?.project_identity).toEqual({
      kind: "synthetic",
      key: "codex:scratch",
      displayName: "Chats",
    });
  });

  it("combines full text with structured filters", () => {
    const codex = {
      ...makeSession("structured"),
      slug: "codex/structured",
      title: "Structured Retrieval",
      directory: "/tmp/codesesh",
      project_identity: {
        kind: "path" as const,
        key: "/tmp/codesesh",
        displayName: "codesesh",
      },
      smart_tags: ["feature-dev" as const],
      smart_tags_source_updated_at: now,
      stats: {
        message_count: 2,
        total_input_tokens: 1,
        total_output_tokens: 1,
        total_cost: 2,
      },
    };
    const other = {
      ...makeSession("other"),
      slug: "cursor/other",
      directory: "/tmp/other",
      smart_tags: ["docs" as const],
    };

    saveCachedSessions("codex", [codex]);
    saveCachedSessions("cursor", [other]);
    syncSessionSearchIndex("codex", [codex], () => ({
      ...codex,
      messages: [
        {
          id: "structured-user",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "needle structured search" }],
        },
        {
          id: "structured-tool",
          role: "assistant",
          time_created: now + 1,
          mode: "tool",
          parts: [
            {
              type: "tool",
              tool: "apply_patch",
              state: { input: { path: "src/App.tsx" } },
            },
          ],
        },
      ],
    }));
    syncSessionSearchIndex("cursor", [other], () => makeSessionData("other", "needle other"));

    const results = searchSessions(
      "needle agent:codex project:codesesh tag:feature-dev tool:apply_patch file:App.tsx cost:>1",
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("structured");
    expect(results[0]?.matchType).toBe("user_message");
    expect(results[0]?.session.smart_tags).toEqual(["feature-dev"]);
  });

  it("returns recent sessions for structured-only queries", () => {
    const recent = {
      ...makeSession("recent"),
      slug: "codex/recent",
      time_updated: now + 10,
      smart_tags: ["testing" as const],
    };
    const old = {
      ...makeSession("old"),
      slug: "codex/old",
      time_updated: now - 10,
      smart_tags: ["docs" as const],
    };

    saveCachedSessions("codex", [old, recent]);
    syncSessionSearchIndex("codex", [old, recent], (sessionId) =>
      makeSessionData(sessionId, "indexed content"),
    );

    const results = searchSessions("agent:codex tag:testing");

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("recent");
    expect(results[0]?.matchType).toBe("recent");
  });

  it("upserts parent session rows before indexed messages", () => {
    const session = {
      ...makeSession("windowed"),
      slug: "claudecode/windowed",
      stats: { ...makeSession("windowed").stats, message_count: 1 },
    };

    saveCachedSessions("cursor", [makeSession("existing")]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "windowed sqlite index" }],
        },
      ],
    }));

    const results = searchSessions("windowed");
    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("windowed");

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const parent = db
        .prepare("SELECT session_id FROM sessions WHERE agent_name = ? AND session_id = ?")
        .get("claudecode", "windowed") as { session_id?: string };
      const child = db
        .prepare("SELECT COUNT(*) AS value FROM messages WHERE agent_name = ? AND session_id = ?")
        .get("claudecode", "windowed") as { value?: number };

      expect(parent.session_id).toBe("windowed");
      expect(child.value).toBe(1);
    } finally {
      db.close();
    }
  });

  it("supports OR queries and agent filters", () => {
    const alpha = makeSession("alpha");
    const beta = makeSession("beta");
    saveCachedSessions("claudecode", [alpha]);
    saveCachedSessions("cursor", [beta]);
    syncSessionSearchIndex("claudecode", [alpha], (sessionId) =>
      makeSessionData(sessionId, "search alpha term"),
    );
    syncSessionSearchIndex("cursor", [beta], (sessionId) =>
      makeSessionData(sessionId, "search beta term"),
    );

    const allResults = searchSessions("alpha OR beta");
    expect(allResults).toHaveLength(2);

    const filteredResults = searchSessions("alpha OR beta", { agent: "cursor" });
    expect(filteredResults).toHaveLength(1);
    expect(filteredResults[0]?.agentName).toBe("cursor");
  });

  it("rebuilds an empty FTS index when content rows exist", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    const db = new Database(getCachePath());
    try {
      createLegacyCacheTables(db);
      db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', '4')").run();
      db.exec(`
        CREATE TABLE session_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          directory TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER,
          activity_time INTEGER NOT NULL,
          content_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          indexed_at INTEGER NOT NULL,
          UNIQUE(agent_name, session_id)
        );

        CREATE VIRTUAL TABLE session_documents_fts USING fts5(
          title,
          content_text,
          content='session_documents',
          content_rowid='id'
        );
      `);
      db.prepare(
        `
          INSERT INTO session_documents(
            agent_name,
            session_id,
            slug,
            title,
            directory,
            time_created,
            time_updated,
            activity_time,
            content_text,
            content_hash,
            indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "claudecode",
        "fts-empty",
        "claudecode/fts-empty",
        "FTS Empty",
        FIXTURE_DIR,
        now,
        now,
        now,
        "orphan index content",
        "old",
        now,
      );
    } finally {
      db.close();
    }

    const results = searchSessions("orphan");

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("fts-empty");
    expect(results[0]?.snippet).toContain("<mark>orphan</mark>");
  });
});
