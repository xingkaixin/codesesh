import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBookmarks, type BookmarkRecord } from "../../state/bookmarks.js";
import { createSessionIdentity } from "../../contract/index.js";
import { setStateSchemaEnsuredPath } from "../../state/database.js";
import type { SessionHead } from "../../types/index.js";
import { setSchemaEnsuredPath } from "../cache/db.js";
import { searchFileActivitySessions } from "../cache/file-activity.js";
import { listCachedProjectGroups } from "../cache/project-groups.js";
import {
  loadCachedSessionData,
  loadCachedSessionRawEntry,
  loadCachedSessions,
  saveCachedSessions,
} from "../cache/sessions.js";
import { searchSessions } from "../cache/search.js";
import {
  createReleaseCacheFixture,
  EXPECTED_CACHE_SCHEMA_VERSION,
  expectedBackupCount,
  hasStructuredMessages,
  RELEASE_CACHE_FIXTURES,
  type MigrationFixtureSeed,
  type ReleaseCacheFixture,
} from "./migration-fixtures.js";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-smoke-"));
const FIXTURE_DIR_NAME = FIXTURE_DIR.split(/[\\/]/).pop()!;
const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-migration-smoke-"));
const now = 1_700_000_000_000;
const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), "scan-cache.json");
}

function getStateDir(): string {
  return join(testHomeDir, ".local", "share", "codesesh");
}

function getStatePath(): string {
  return join(getStateDir(), "state.db");
}

function highlightedText(
  result: { snippet: string; snippetHighlights: Array<{ start: number; end: number }> } | undefined,
): string[] {
  return result?.snippetHighlights.map(({ start, end }) => result.snippet.slice(start, end)) ?? [];
}

function makeSession(): SessionHead {
  return {
    ...createSessionIdentity({ agentName: "claudecode", sessionId: "legacy-smoke" }),
    title: "Legacy smoke session",
    directory: FIXTURE_DIR,
    project_identity: {
      kind: "path",
      key: FIXTURE_DIR,
      displayName: FIXTURE_DIR_NAME,
    },
    time_created: now - 1_000,
    time_updated: now,
    stats: {
      message_count: 1,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_cost: 0,
      total_tokens: 15,
    },
  };
}

function makeSeed(): MigrationFixtureSeed {
  return {
    agentName: "claudecode",
    session: makeSession(),
    sourcePath: join(FIXTURE_DIR, "session.jsonl"),
    searchContent: "legacy migration smoke needle content",
    messageText: "structured detail survived migration",
    filePath: join(FIXTURE_DIR, "src", "legacy.ts"),
    now,
  };
}

function createCacheFixture(fixture: ReleaseCacheFixture, populated = true): void {
  mkdirSync(getCacheDir(), { recursive: true });
  const db = new Database(getCachePath());
  try {
    createReleaseCacheFixture(db, fixture, populated ? makeSeed() : undefined);
  } finally {
    db.close();
  }
}

function createLegacyStateFixture(version: 1 | 2): void {
  mkdirSync(getStateDir(), { recursive: true });
  const db = new Database(getStatePath());
  const session = makeSession();

  try {
    db.exec(`
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
    if (version === 2) {
      db.exec(`
        CREATE TABLE session_aliases (
          agent_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_name, session_id)
        );
      `);
    }
    db.pragma(`user_version = ${version === 2 ? 2 : 0}`);
    db.prepare("INSERT INTO state_meta(key, value) VALUES ('version', ?)").run(String(version));
    db.prepare(
      `
        INSERT INTO bookmarks(
          agent_name, session_id, slug, title, directory, time_created,
          time_updated, stats_json, bookmarked_at
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

function getMigrationBackups(): string[] {
  if (!existsSync(getCacheDir())) return [];
  return readdirSync(getCacheDir())
    .filter((name) => name.startsWith("codesesh.db.") && name.endsWith(".bak"))
    .sort();
}

function getStateMigrationBackups(): string[] {
  if (!existsSync(getStateDir())) return [];
  return readdirSync(getStateDir())
    .filter(
      (name) =>
        name.startsWith("state.db.") && name.includes(".state-migration") && name.endsWith(".bak"),
    )
    .sort();
}

function getBookmarkColumns(): string[] {
  const db = new Database(getStatePath(), { readonly: true });
  try {
    return (db.prepare("PRAGMA table_info(bookmarks)").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    );
  } finally {
    db.close();
  }
}

function readMigratedFacts(): Record<string, unknown> {
  const db = new Database(getCachePath(), { readonly: true });
  try {
    const scalar = (sql: string): number => {
      const row = db.prepare(sql).get() as { value?: number } | undefined;
      return Number(row?.value ?? 0);
    };
    return {
      userVersion: Number(db.pragma("user_version", { simple: true })),
      cacheVersion: (
        db.prepare("SELECT value FROM cache_meta WHERE key = 'version'").get() as {
          value?: string;
        }
      ).value,
      integrity: (
        db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined
      )?.integrity_check,
      foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all(),
      cachedSessions: scalar("SELECT COUNT(*) AS value FROM cached_sessions"),
      sessions: scalar("SELECT COUNT(*) AS value FROM sessions"),
      messages: scalar("SELECT COUNT(*) AS value FROM messages"),
      messageTools: scalar("SELECT COUNT(*) AS value FROM message_tools"),
      fileActivity: scalar("SELECT COUNT(*) AS value FROM session_file_activity"),
      searchDocuments: scalar("SELECT COUNT(*) AS value FROM session_documents"),
      projects: scalar("SELECT COUNT(*) AS value FROM project_sessions"),
      pendingReindex: scalar("SELECT COUNT(*) AS value FROM pending_reindex"),
      legacyMessageSearchObjects: scalar(
        "SELECT COUNT(*) AS value FROM sqlite_master WHERE name IN ('messages_fts', 'messages_ai', 'messages_ad', 'messages_au')",
      ),
      sessionActivityIndexes: (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_sessions_agent_activity%'",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
      documentColumns: (
        db.prepare("PRAGMA table_info(session_documents)").all() as Array<{ name: string }>
      )
        .map((row) => row.name)
        .sort(),
      sessionColumns: (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>)
        .map((row) => row.name)
        .sort(),
    };
  } finally {
    db.close();
  }
}

function expectMigratedBehavior(structured: boolean): void {
  const cached = loadCachedSessions("claudecode");
  const detail = loadCachedSessionData("claudecode", "legacy-smoke");
  const rawDetail = loadCachedSessionRawEntry("claudecode", "legacy-smoke");
  const projects = listCachedProjectGroups();
  const results = searchSessions("needle");

  expect(cached?.sessions.map((session) => session.id)).toEqual(["legacy-smoke"]);
  expect(cached?.sessions[0]?.reference).toEqual({
    agentName: "claudecode",
    sessionId: "legacy-smoke",
  });
  expect(cached?.sessions[0]?.stats).toMatchObject({
    message_count: 1,
    total_input_tokens: 10,
    total_output_tokens: 5,
    total_tokens: 15,
  });
  expect(detail?.id).toBe("legacy-smoke");
  expect(detail?.messages).toEqual([]);
  expect(rawDetail?.pendingReindex).toBe(true);
  expect(rawDetail?.messageRows).toHaveLength(structured ? 1 : 0);
  if (structured) {
    expect(JSON.parse(String(rawDetail?.messageRows[0]?.parts_json))).toEqual([
      { type: "text", text: "structured detail survived migration" },
    ]);
  }
  expect(projects).toEqual([
    {
      identityKind: "path",
      identityKey: FIXTURE_DIR,
      displayName: FIXTURE_DIR_NAME,
      sources: ["claudecode"],
      sessionCount: 1,
      lastActivity: now,
    },
  ]);
  expect(results).toHaveLength(1);
  expect(results[0]?.session.id).toBe("legacy-smoke");
  expect(highlightedText(results[0])).toContain("needle");

  if (structured) {
    const toolResults = searchSessions("tool:read");
    const fileResults = searchFileActivitySessions("legacy.ts");
    expect(toolResults.map((result) => result.session.id)).toEqual(["legacy-smoke"]);
    expect(fileResults.map((result) => result.session.id)).toEqual(["legacy-smoke"]);
    expect(highlightedText(fileResults[0])).toContain("legacy.ts");
  }
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  rmSync(getStateDir(), { recursive: true, force: true });
  setStateSchemaEnsuredPath(null);
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  rmSync(getStateDir(), { recursive: true, force: true });
  setStateSchemaEnsuredPath(null);
});

afterAll(() => {
  dateNowSpy.mockRestore();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(testHomeDir, { recursive: true, force: true });
});

describe("sqlite migration release gate", () => {
  it("registers every released SQLite schema epoch", () => {
    expect(RELEASE_CACHE_FIXTURES).toEqual([
      { version: 3, sourceTag: "v0.3.0" },
      { version: 4, sourceTag: "v0.4.0" },
      { version: 6, sourceTag: "v0.5.0" },
      { version: 8, sourceTag: "v0.6.0" },
      { version: 13, sourceTag: "v0.7.0" },
      { version: 14, sourceTag: "v0.14.0" },
      { version: 17, sourceTag: "v0.17.0" },
      { version: 18, sourceTag: "v1.0.0" },
    ]);
  });

  it.each(RELEASE_CACHE_FIXTURES)(
    "migrates schema v$version from $sourceTag through public storage APIs",
    (fixture) => {
      createCacheFixture(fixture);
      const structured = hasStructuredMessages(fixture);

      expectMigratedBehavior(structured);
      const migratedFacts = readMigratedFacts();
      expect(migratedFacts).toEqual({
        userVersion: EXPECTED_CACHE_SCHEMA_VERSION,
        cacheVersion: String(EXPECTED_CACHE_SCHEMA_VERSION),
        integrity: "ok",
        foreignKeyViolations: [],
        cachedSessions: 1,
        sessions: 1,
        messages: structured ? 1 : 0,
        messageTools: structured ? 1 : 0,
        fileActivity: structured ? 1 : 0,
        searchDocuments: 1,
        projects: 1,
        pendingReindex: 1,
        legacyMessageSearchObjects: 0,
        sessionActivityIndexes: ["idx_sessions_agent_activity_order"],
        documentColumns: [
          "agent_name",
          "content_hash",
          "content_text",
          "detail_version",
          "id",
          "indexed_at",
          "indexed_message_count",
          "session_id",
          "title",
        ],
        sessionColumns: [
          "activity_time",
          "agent_name",
          "cost_source",
          "directory",
          "message_count",
          "meta_json",
          "model_usage_json",
          "parent_agent_name",
          "parent_session_id",
          "project_display_name",
          "project_identity_input_signature",
          "project_identity_key",
          "project_identity_kind",
          "project_identity_resolver_revision",
          "publication_id",
          "session_id",
          "smart_tags_classifier_revision",
          "smart_tags_json",
          "smart_tags_source_updated_at",
          "sort_index",
          "source_path",
          "time_created",
          "time_updated",
          "title",
          "total_cache_create_tokens",
          "total_cache_read_tokens",
          "total_cost",
          "total_input_tokens",
          "total_output_tokens",
          "total_tokens",
        ],
      });
      const backups = getMigrationBackups();
      expect(backups).toHaveLength(expectedBackupCount(fixture));

      setSchemaEnsuredPath(null);
      expectMigratedBehavior(structured);
      expect(readMigratedFacts()).toEqual(migratedFacts);
      expect(getMigrationBackups()).toEqual(backups);
    },
    30_000,
  );

  it("upgrades an empty pre-compaction cache without a meaningless backup", () => {
    const fixture = RELEASE_CACHE_FIXTURES.find(({ version }) => version === 14)!;
    createCacheFixture(fixture, false);

    expect(loadCachedSessions("claudecode")).toBeNull();
    expect(getUserVersion(getCachePath())).toBe(EXPECTED_CACHE_SCHEMA_VERSION);
    expect(getMigrationBackups()).toEqual([]);
  });

  it("replaces the released v2 JSON cache on the first SQLite write", () => {
    const session = makeSession();
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(
      getLegacyCachePath(),
      JSON.stringify({
        version: 2,
        entries: {
          claudecode: {
            sessions: [session],
            meta: { [session.id]: { id: session.id, sourcePath: "legacy.jsonl" } },
            timestamp: now,
            version: 2,
          },
        },
        lastScanTime: now,
      }),
    );

    expect(loadCachedSessions("claudecode")).toBeNull();
    expect(saveCachedSessions("claudecode", [session])).toBe(true);
    expect(existsSync(getLegacyCachePath())).toBe(false);
    expect(loadCachedSessions("claudecode")?.sessions.map(({ id }) => id)).toEqual([
      "legacy-smoke",
    ]);
    expect(getUserVersion(getCachePath())).toBe(EXPECTED_CACHE_SCHEMA_VERSION);
  });

  it.each([1, 2] as const)("migrates the released state v%s bookmark schema", (version) => {
    createLegacyStateFixture(version);

    const bookmarks: BookmarkRecord[] = listBookmarks();

    expect(bookmarks).toEqual([
      {
        reference: { agentName: "claudecode", sessionId: "legacy-smoke" },
        bookmarkedAt: now - 500,
      },
    ]);
    expect(getBookmarkColumns()).toEqual(["agent_name", "session_id", "bookmarked_at"]);
    expect(getStateMigrationBackups()).toHaveLength(1);
    expect(getUserVersion(getStatePath())).toBe(3);
  });
});
