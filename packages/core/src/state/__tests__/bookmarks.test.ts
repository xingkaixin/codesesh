import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteBookmark,
  importBookmarks,
  listBookmarks,
  upsertBookmark,
  type BookmarkRecord,
} from "../bookmarks.js";

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

function makeBookmark(
  overrides: Partial<Omit<BookmarkRecord, "bookmarked_at">> = {},
): Omit<BookmarkRecord, "bookmarked_at"> {
  return {
    agentKey: overrides.agentKey ?? "codex",
    sessionId: overrides.sessionId ?? "s1",
    fullPath: overrides.fullPath ?? "codex/s1",
    title: overrides.title ?? "Session 1",
    directory: overrides.directory ?? "/tmp/project",
    time_created: overrides.time_created ?? now - 1000,
    time_updated: overrides.time_updated ?? now,
    stats: overrides.stats ?? {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0,
    },
  };
}

beforeEach(() => {
  rmSync(getStateDir(), { recursive: true, force: true });
  dateNowSpy.mockReturnValue(now);
});

afterEach(() => {
  rmSync(getStateDir(), { recursive: true, force: true });
});

describe("bookmarks state storage", () => {
  it("persists and lists bookmarks", () => {
    upsertBookmark(makeBookmark());

    expect(listBookmarks()).toEqual([
      {
        ...makeBookmark(),
        bookmarked_at: now,
      },
    ]);
  });

  it("preserves bookmarked_at when refreshing a snapshot", () => {
    upsertBookmark(makeBookmark({ title: "Old title" }));
    dateNowSpy.mockReturnValue(now + 5000);

    const updated = upsertBookmark(makeBookmark({ title: "New title" }));

    expect(updated.bookmarked_at).toBe(now);
    expect(listBookmarks()[0]?.title).toBe("New title");
    expect(listBookmarks()[0]?.bookmarked_at).toBe(now);
  });

  it("imports multiple bookmarks without duplicating existing rows", () => {
    upsertBookmark(makeBookmark({ sessionId: "s1", title: "Before import" }));

    const imported = importBookmarks([
      makeBookmark({ sessionId: "s1", title: "After import" }),
      makeBookmark({
        agentKey: "cursor",
        sessionId: "s2",
        fullPath: "cursor/s2",
        title: "Cursor session",
      }),
    ]);

    expect(imported).toHaveLength(2);
    expect(imported.map((bookmark) => bookmark.title)).toEqual(["After import", "Cursor session"]);
  });

  it("deletes a bookmark by agent and session", () => {
    upsertBookmark(makeBookmark());
    deleteBookmark("codex", "s1");
    expect(listBookmarks()).toEqual([]);
  });
});
