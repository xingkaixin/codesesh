import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBookmarks, type BookmarkRecord } from "../../state/bookmarks.js";
import { listCachedProjectGroups, loadCachedSessions, searchSessions } from "../cache.js";
import type { SessionHead } from "../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-migration-smoke-"));
const now = 1_700_000_000_000;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

vi.spyOn(Date, "now").mockReturnValue(now);

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

function getStateDir(): string {
  return join(testHomeDir, ".local", "share", "codesesh");
}

function getStatePath(): string {
  return join(getStateDir(), "state.db");
}

function makeSession(): SessionHead {
  return {
    id: "legacy-smoke",
    slug: "claudecode/legacy-smoke",
    title: "Legacy smoke session",
    directory: "/tmp/codesesh-legacy",
    project_identity: {
      kind: "path",
      key: "/tmp/codesesh-legacy",
      displayName: "codesesh-legacy",
    },
    time_created: now - 1_000,
    time_updated: now,
    stats: {
      message_count: 2,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_cost: 0,
      total_tokens: 15,
    },
  };
}

function createLegacyCacheFixture(): void {
  mkdirSync(getCacheDir(), { recursive: true });
  const db = new Database(getCachePath());
  const session = makeSession();

  try {
    db.exec(`
      PRAGMA user_version = 0;

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

    db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', '4')").run();
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
      session.id,
      session.slug,
      session.title,
      session.directory,
      session.time_created,
      session.time_updated,
      session.time_updated,
      "legacy migration smoke needle content",
      "old-hash",
      now,
    );
  } finally {
    db.close();
  }
}

function createLegacyStateFixture(): void {
  mkdirSync(getStateDir(), { recursive: true });
  const db = new Database(getStatePath());
  const session = makeSession();

  try {
    db.exec(`
      PRAGMA user_version = 0;

      CREATE TABLE state_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE bookmarks (
        agent_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER,
        stats_json TEXT NOT NULL,
        bookmarked_at INTEGER NOT NULL,
        PRIMARY KEY (agent_name, session_id)
      );
    `);

    db.prepare("INSERT INTO state_meta(key, value) VALUES ('version', '1')").run();
    db.prepare(
      `
        INSERT INTO bookmarks(
          agent_name,
          session_id,
          slug,
          title,
          directory,
          time_created,
          time_updated,
          stats_json,
          bookmarked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "claudecode",
      session.id,
      session.slug,
      session.title,
      session.directory,
      session.time_created,
      session.time_updated,
      JSON.stringify(session.stats),
      now - 500,
    );
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

beforeEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  rmSync(getStateDir(), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  rmSync(getStateDir(), { recursive: true, force: true });
});

describe("sqlite migration smoke", () => {
  it("migrates old cache and state fixtures for browsing data", () => {
    createLegacyCacheFixture();
    createLegacyStateFixture();

    const cached = loadCachedSessions("claudecode");
    const projects = listCachedProjectGroups();
    const results = searchSessions("needle");
    const bookmarks: BookmarkRecord[] = listBookmarks();

    expect(cached?.sessions.map((session) => session.id)).toEqual(["legacy-smoke"]);
    expect(cached?.sessions[0]?.stats.total_tokens).toBe(15);
    expect(projects).toEqual([
      {
        identityKind: "path",
        identityKey: "/tmp/codesesh-legacy",
        displayName: "codesesh-legacy",
        sources: ["claudecode"],
        sessionCount: 1,
        lastActivity: now,
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("legacy-smoke");
    expect(results[0]?.snippet).toContain("<mark>needle</mark>");
    expect(bookmarks).toEqual([
      {
        agentKey: "claudecode",
        sessionId: "legacy-smoke",
        fullPath: "claudecode/legacy-smoke",
        title: "Legacy smoke session",
        directory: "/tmp/codesesh-legacy",
        time_created: now - 1_000,
        time_updated: now,
        stats: {
          message_count: 2,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0,
          total_tokens: 15,
        },
        bookmarked_at: now - 500,
      },
    ]);
    expect(getUserVersion(getCachePath())).toBe(9);
    expect(getUserVersion(getStatePath())).toBe(1);
  }, 15_000);
});
