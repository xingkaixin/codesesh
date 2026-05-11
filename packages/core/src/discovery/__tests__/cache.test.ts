import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getCacheInfo,
  listCachedProjectGroups,
  loadCachedSessions,
  searchSessions,
  saveCachedSessions,
  syncSessionSearchIndex,
  type SessionCacheMeta,
} from "../cache.js";
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

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: "/tmp/project",
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
});

afterEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("loadCachedSessions", () => {
  it("returns null when cache db does not exist", () => {
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when agent is not cached", () => {
    saveCachedSessions("cursor", [makeSession("s1")]);
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when cache is too old", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    dateNowSpy.mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    expect(loadCachedSessions("claudecode")).toBeNull();
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

describe("saveCachedSessions", () => {
  it("creates sqlite cache db", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(readFileSync(getCachePath()).byteLength).toBeGreaterThan(0);
    expect(getUserVersion(getCachePath())).toBe(7);
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
    expect(getUserVersion(getCachePath())).toBe(7);
    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "path",
        identityKey: "/tmp/project",
        displayName: "project",
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
        "/tmp/project",
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
