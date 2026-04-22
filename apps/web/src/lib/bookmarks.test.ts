import { describe, expect, it } from "vitest";
import type { SessionHead } from "./api";
import {
  getSessionBookmarkKey,
  mergeBookmarksWithSessions,
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
});
