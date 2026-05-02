import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "./api";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  mergeBookmarksWithSessions,
  sortBookmarkedSessions,
  toBookmarkedSessionSnapshot,
} from "./bookmarks";

function createSession(
  overrides: Partial<SessionHead> & Pick<SessionHead, "id" | "slug" | "title">,
): SessionHead {
  return {
    id: overrides.id,
    slug: overrides.slug,
    title: overrides.title,
    directory: overrides.directory ?? "/tmp/project",
    time_created: overrides.time_created ?? 100,
    time_updated: overrides.time_updated,
    stats: overrides.stats ?? {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0,
    },
  };
}

describe("bookmarks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses agent + session id as bookmark key", () => {
    expect(getSessionBookmarkKey("codex", "abc")).toBe("codex:abc");
  });

  it("builds a snapshot from session head", () => {
    const session = createSession({
      id: "s1",
      slug: "codex/s1",
      title: "Bookmark me",
      time_updated: 200,
    });

    expect(toBookmarkedSessionSnapshot(session, "codex")).toEqual({
      sessionId: "s1",
      agentKey: "codex",
      fullPath: "codex/s1",
      title: "Bookmark me",
      directory: "/tmp/project",
      time_created: 100,
      time_updated: 200,
      stats: session.stats,
      bookmarked_at: expect.any(Number),
    });
  });

  it("refreshes stored snapshots when live sessions change", () => {
    const bookmark = toBookmarkedSessionSnapshot(
      createSession({
        id: "s1",
        slug: "codex/s1",
        title: "Old title",
        time_updated: 100,
      }),
      "codex",
    );

    const merged = mergeBookmarksWithSessions(
      [bookmark],
      [
        createSession({
          id: "s1",
          slug: "codex/s1",
          title: "New title",
          time_updated: 300,
          stats: {
            message_count: 5,
            total_input_tokens: 8,
            total_output_tokens: 13,
            total_cost: 0,
            total_tokens: 21,
          },
        }),
      ],
    );

    expect(merged[0]?.title).toBe("New title");
    expect(merged[0]?.time_updated).toBe(300);
    expect(merged[0]?.stats.total_tokens).toBe(21);
  });

  it("loads valid legacy bookmarks and drops invalid entries", () => {
    const older = toBookmarkedSessionSnapshot(
      createSession({ id: "old", slug: "codex/old", title: "Old", time_updated: 100 }),
      "codex",
    );
    const newer = toBookmarkedSessionSnapshot(
      createSession({ id: "new", slug: "codex/new", title: "New", time_updated: 300 }),
      "codex",
    );
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() =>
          JSON.stringify([
            older,
            { ...newer, bookmarked_at: "bad" },
            newer,
            { sessionId: "bad", stats: { message_count: "bad" } },
          ]),
        ),
        removeItem,
      },
    });

    expect(loadLegacyBookmarks().map((bookmark) => bookmark.sessionId)).toEqual(["new", "old"]);
    clearLegacyBookmarks();
    expect(removeItem).toHaveBeenCalledWith("codesesh:bookmarks:v1");
  });

  it("returns empty legacy bookmarks for missing or malformed storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => "{bad json"),
        removeItem: vi.fn(),
      },
    });

    expect(loadLegacyBookmarks()).toEqual([]);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => JSON.stringify({ sessionId: "not-array" })),
        removeItem: vi.fn(),
      },
    });

    expect(loadLegacyBookmarks()).toEqual([]);
  });

  it("keeps bookmark arrays unchanged when live sessions add no new data", () => {
    const bookmark = toBookmarkedSessionSnapshot(
      createSession({ id: "s1", slug: "codex/s1", title: "Same", time_updated: 100 }),
      "codex",
    );
    const bookmarks = [bookmark];

    expect(
      mergeBookmarksWithSessions(
        [],
        [createSession({ id: "s1", slug: "codex/s1", title: "Same" })],
      ),
    ).toEqual([]);
    expect(mergeBookmarksWithSessions(bookmarks, [])).toBe(bookmarks);
    expect(
      mergeBookmarksWithSessions(bookmarks, [
        createSession({ id: "s1", slug: "codex/s1", title: "Same", time_updated: 100 }),
      ]),
    ).toBe(bookmarks);
  });

  it("sorts bookmarks by updated time with created time fallback", () => {
    const createdOnly = toBookmarkedSessionSnapshot(
      createSession({ id: "created", slug: "codex/created", title: "Created", time_created: 200 }),
      "codex",
    );
    const updated = toBookmarkedSessionSnapshot(
      createSession({ id: "updated", slug: "codex/updated", title: "Updated", time_updated: 300 }),
      "codex",
    );

    expect(
      [createdOnly, updated].toSorted(sortBookmarkedSessions).map((item) => item.sessionId),
    ).toEqual(["updated", "created"]);
  });
});
