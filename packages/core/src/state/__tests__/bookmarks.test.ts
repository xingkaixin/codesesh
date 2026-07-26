import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

interface BookmarkOverrides {
  agentName?: string;
  sessionId?: string;
  title?: string;
  directory?: string;
  timeCreated?: number;
  timeUpdated?: number;
  stats?: BookmarkRecord["session"]["stats"];
}

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

function makeBookmark(overrides: BookmarkOverrides = {}): Omit<BookmarkRecord, "bookmarkedAt"> {
  const reference = {
    agentName: overrides.agentName ?? "codex",
    sessionId: overrides.sessionId ?? "s1",
  };
  return {
    reference,
    session: {
      id: reference.sessionId,
      slug: `${reference.agentName}/${reference.sessionId}`,
      title: overrides.title ?? "Session 1",
      directory: overrides.directory ?? "/tmp/project",
      time_created: overrides.timeCreated ?? now - 1000,
      time_updated: overrides.timeUpdated ?? now,
      stats: overrides.stats ?? {
        message_count: 1,
        total_input_tokens: 2,
        total_output_tokens: 3,
        total_cost: 0,
      },
    },
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
  it("persists and lists bookmarks", () => {
    upsertBookmark(makeBookmark());

    expect(listBookmarks()).toEqual([
      {
        ...makeBookmark(),
        bookmarkedAt: now,
      },
    ]);
    expect(getUserVersion(getStatePath())).toBe(2);
  });

  it("derives canonical identity fields instead of trusting the legacy slug column", () => {
    const bookmark = makeBookmark({ agentName: " CoDeX " });
    bookmark.session.slug = "stale/route";
    upsertBookmark(bookmark);

    const db = new Database(getStatePath());
    try {
      db.prepare("UPDATE bookmarks SET slug = 'another/stale-route'").run();
    } finally {
      db.close();
    }

    expect(listBookmarks()[0]).toMatchObject({
      reference: { agentName: "codex", sessionId: "s1" },
      session: { id: "s1", slug: "codex/s1" },
    });
  });

  it("preserves bookmarkedAt when refreshing a snapshot", () => {
    upsertBookmark(makeBookmark({ title: "Old title" }));
    dateNowSpy.mockReturnValue(now + 5000);

    const updated = upsertBookmark(makeBookmark({ title: "New title" }));

    expect(updated.bookmarkedAt).toBe(now);
    expect(listBookmarks()[0]?.session.title).toBe("New title");
    expect(listBookmarks()[0]?.bookmarkedAt).toBe(now);
  });

  it("imports multiple bookmarks without duplicating existing rows", () => {
    upsertBookmark(makeBookmark({ sessionId: "s1", title: "Before import" }));

    const imported = importBookmarks([
      makeBookmark({ sessionId: "s1", title: "After import" }),
      makeBookmark({
        agentName: "cursor",
        sessionId: "s2",
        title: "Cursor session",
      }),
    ]);

    expect(imported).toHaveLength(2);
    expect(imported.map((bookmark) => bookmark.session.title)).toEqual([
      "After import",
      "Cursor session",
    ]);
  });

  it("deletes a bookmark by normalized session reference", () => {
    upsertBookmark(makeBookmark());
    deleteBookmark({ agentName: " CoDeX ", sessionId: "s1" });
    expect(listBookmarks()).toEqual([]);
  });

  it("uses an explicit state directory when configured", () => {
    const stateDir = join(testHomeDir, "custom-state");
    vi.stubEnv("CODESESH_STATE_DIR", stateDir);

    upsertBookmark(makeBookmark());

    expect(getUserVersion(join(stateDir, "state.db"))).toBe(2);
  });

  it("uses memory state storage when configured", () => {
    vi.stubEnv("CODESESH_STATE_STORE", "memory");

    expect(upsertBookmark(makeBookmark()).bookmarkedAt).toBe(now);
    expect(listBookmarks()).toEqual([{ ...makeBookmark(), bookmarkedAt: now }]);
    expect(existsSync(getStatePath())).toBe(false);

    deleteBookmark({ agentName: "codex", sessionId: "s1" });
    expect(listBookmarks()).toEqual([]);
  });

  it("migrates legacy state metadata to user_version", () => {
    upsertBookmark(makeBookmark());
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

    // Force ensureSchema to re-run against the externally rewritten file,
    // as a fresh process would on its first open.
    setStateSchemaEnsuredPath(null);
    expect(listBookmarks()[0]?.reference.sessionId).toBe("s1");
    expect(getUserVersion(getStatePath())).toBe(2);
  });

  it("does not downgrade a state database created by a newer version", () => {
    upsertBookmark(makeBookmark());
    const db = new Database(getStatePath());
    try {
      db.exec("PRAGMA user_version = 3");
    } finally {
      db.close();
    }

    setStateSchemaEnsuredPath(null);
    expect(listBookmarks()[0]?.reference.sessionId).toBe("s1");
    expect(getUserVersion(getStatePath())).toBe(3);
  });
});
