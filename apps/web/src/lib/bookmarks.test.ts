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
    expect(getSessionBookmarkKey({ agentName: "codex", sessionId: "abc" })).toBe('["codex","abc"]');
  });

  it("builds a snapshot from session head", () => {
    const session = createSession({
      id: "s1",
      slug: "codex/s1",
      title: "Bookmark me",
      time_updated: 200,
    });

    expect(toBookmarkedSessionSnapshot(session, "codex")).toEqual({
      reference: { agentName: "codex", sessionId: "s1" },
      session,
      bookmarkedAt: expect.any(Number),
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

    expect(merged[0]?.session.title).toBe("New title");
    expect(merged[0]?.session.time_updated).toBe(300);
    expect(merged[0]?.session.stats.total_tokens).toBe(21);
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
    const toLegacy = (bookmark: typeof older) => ({
      agentKey: bookmark.reference.agentName,
      sessionId: bookmark.reference.sessionId,
      fullPath: bookmark.session.slug,
      title: bookmark.session.title,
      directory: bookmark.session.directory,
      time_created: bookmark.session.time_created,
      time_updated: bookmark.session.time_updated,
      stats: bookmark.session.stats,
      bookmarked_at: bookmark.bookmarkedAt,
    });
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() =>
          JSON.stringify([
            toLegacy(older),
            { ...toLegacy(newer), bookmarked_at: "bad" },
            toLegacy(newer),
            { ...toLegacy(newer), agentKey: " " },
            { ...toLegacy(newer), sessionId: "" },
            { sessionId: "bad", stats: { message_count: "bad" } },
          ]),
        ),
        removeItem,
      },
    });

    expect(loadLegacyBookmarks().map((bookmark) => bookmark.reference.sessionId)).toEqual([
      "new",
      "old",
    ]);
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
      [createdOnly, updated]
        .toSorted(sortBookmarkedSessions)
        .map((item) => item.reference.sessionId),
    ).toEqual(["updated", "created"]);
  });
});
