import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteBookmark,
  importBookmarks,
  listBookmarks,
  upsertBookmark,
  type BookmarkRecord,
} from "../bookmarks.js";
import { setStateSchemaEnsuredPath } from "../database.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-bookmarks-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

const now = 1_700_000_000_000;
const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

function getStateDir(): string {
  return join(testHomeDir, ".local", "share", "codesesh");
}

function getStatePath(): string {
  return join(getStateDir(), "state.db");
}

function getUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

function makeBookmark(sessionId = "s1", agentName = "codex", bookmarkedAt = now): BookmarkRecord {
  return {
    reference: { agentName, sessionId },
    bookmarkedAt,
  };
}

beforeEach(() => {
  rmSync(getStateDir(), { recursive: true, force: true });
  setStateSchemaEnsuredPath(null);
  dateNowSpy.mockReturnValue(now);
});

afterEach(() => {
  rmSync(join(testHomeDir, "custom-state"), { recursive: true, force: true });
  vi.unstubAllEnvs();
  setStateSchemaEnsuredPath(null);
  rmSync(getStateDir(), { recursive: true, force: true });
});

describe("bookmarks state storage", () => {
  it("persists only bookmark identity and timestamp facts", () => {
    upsertBookmark(makeBookmark().reference);

    expect(listBookmarks()).toEqual([makeBookmark()]);
    expect(getUserVersion(getStatePath())).toBe(3);

    const db = new Database(getStatePath(), { readonly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(bookmarks)").all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual([
        "agent_name",
        "session_id",
        "bookmarked_at",
      ]);
    } finally {
      db.close();
    }
  });

  it("normalizes identity without storing derived session fields", () => {
    upsertBookmark({ agentName: " CoDeX ", sessionId: "s1" });

    expect(listBookmarks()).toEqual([makeBookmark()]);
  });

  it("preserves the original bookmarkedAt when upserting again", () => {
    upsertBookmark(makeBookmark().reference);
    dateNowSpy.mockReturnValue(now + 5_000);

    const existing = upsertBookmark(makeBookmark().reference);

    expect(existing.bookmarkedAt).toBe(now);
    expect(listBookmarks()).toEqual([makeBookmark()]);
  });

  it("returns the inserted bookmark even when it is deleted before a follow-up read", () => {
    listBookmarks();
    const db = new Database(getStatePath());
    try {
      db.exec(`
        CREATE TRIGGER delete_bookmark_after_insert
        AFTER INSERT ON bookmarks
        WHEN NEW.session_id = 'racy'
        BEGIN
          DELETE FROM bookmarks
          WHERE agent_name = NEW.agent_name AND session_id = NEW.session_id;
        END;
      `);
    } finally {
      db.close();
    }

    expect(upsertBookmark(makeBookmark("racy").reference)).toEqual(makeBookmark("racy"));
  });

  it("imports facts idempotently and preserves existing timestamps", () => {
    upsertBookmark(makeBookmark("s1").reference);

    const imported = importBookmarks([
      makeBookmark("s1", "codex", now + 5_000),
      makeBookmark("s2", "cursor", now - 500),
      makeBookmark("s2", "cursor", now + 10_000),
    ]);

    expect(imported).toEqual([makeBookmark("s1"), makeBookmark("s2", "cursor", now - 500)]);
  });

  it("deletes a bookmark by normalized session reference", () => {
    upsertBookmark(makeBookmark().reference);
    deleteBookmark({ agentName: " CoDeX ", sessionId: "s1" });
    expect(listBookmarks()).toEqual([]);
  });

  it("uses an explicit state directory when configured", () => {
    const stateDir = join(testHomeDir, "custom-state");
    vi.stubEnv("CODESESH_STATE_DIR", stateDir);

    upsertBookmark(makeBookmark().reference);

    expect(getUserVersion(join(stateDir, "state.db"))).toBe(3);
  });

  it("uses memory state storage when configured", () => {
    vi.stubEnv("CODESESH_STATE_STORE", "memory");

    expect(upsertBookmark(makeBookmark().reference)).toEqual(makeBookmark());
    expect(listBookmarks()).toEqual([makeBookmark()]);
    expect(existsSync(getStatePath())).toBe(false);

    deleteBookmark(makeBookmark().reference);
    expect(listBookmarks()).toEqual([]);
  });

  it("migrates legacy state metadata to user_version", () => {
    upsertBookmark(makeBookmark().reference);
    const db = new Database(getStatePath());
    try {
      db.exec("PRAGMA user_version = 0");
      db.prepare(
        `
          INSERT INTO state_meta(key, value)
          VALUES ('version', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      ).run();
    } finally {
      db.close();
    }

    setStateSchemaEnsuredPath(null);
    expect(listBookmarks()).toEqual([makeBookmark()]);
    expect(getUserVersion(getStatePath())).toBe(3);
  });

  it("does not downgrade a state database created by a newer version", () => {
    upsertBookmark(makeBookmark().reference);
    const db = new Database(getStatePath());
    try {
      db.exec("PRAGMA user_version = 4");
    } finally {
      db.close();
    }

    setStateSchemaEnsuredPath(null);
    expect(listBookmarks()).toEqual([makeBookmark()]);
    expect(getUserVersion(getStatePath())).toBe(4);
  });
});
