import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "./api";
import {
  clearLegacyBookmarks,
  getSessionBookmarkKey,
  loadLegacyBookmarks,
  toBookmarkView,
} from "./bookmarks";

function createSession(overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: "s1" },
    title: "Bookmark me",
    directory: "/tmp/project",
    time_created: 100,
    time_updated: 200,
    stats: {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0,
    },
    ...overrides,
  };
}

describe("bookmarks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses normalized agent + opaque session id as bookmark key", () => {
    expect(getSessionBookmarkKey({ agentName: " CoDeX ", sessionId: "a/b" })).toBe("codex/a/b");
  });

  it("builds an optimistic available view from a live session", () => {
    vi.spyOn(Date, "now").mockReturnValue(300);
    const session = createSession();

    expect(toBookmarkView(session, " CoDeX ")).toEqual({
      reference: { agentName: "codex", sessionId: "s1" },
      session,
      availability: "available",
      bookmarkedAt: 300,
    });
  });

  it("migrates only durable facts from legacy and current payload shapes", () => {
    vi.spyOn(Date, "now").mockReturnValue(500);
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() =>
          JSON.stringify([
            {
              agentKey: "codex",
              sessionId: "old",
              bookmarked_at: 100,
              title: "Stale title",
              stats: { message_count: "malformed snapshot is ignored" },
            },
            {
              reference: { agentName: " CuRsOr ", sessionId: "new" },
              bookmarkedAt: 300,
              session: { title: "Another stale snapshot" },
            },
            { agentKey: "codex", sessionId: "default-time" },
            { agentKey: " ", sessionId: "missing-agent", bookmarked_at: 400 },
            { agentKey: "codex", sessionId: "", bookmarked_at: 400 },
            { agentKey: "codex", sessionId: "bad-time", bookmarked_at: "400" },
          ]),
        ),
        removeItem,
      },
    });

    expect(loadLegacyBookmarks()).toEqual([
      {
        reference: { agentName: "codex", sessionId: "default-time" },
        bookmarkedAt: 500,
      },
      {
        reference: { agentName: "cursor", sessionId: "new" },
        bookmarkedAt: 300,
      },
      {
        reference: { agentName: "codex", sessionId: "old" },
        bookmarkedAt: 100,
      },
    ]);

    clearLegacyBookmarks();
    expect(removeItem).toHaveBeenCalledWith("codesesh:bookmarks:v1");
  });

  it("returns empty legacy facts for missing, malformed, and server-side storage", () => {
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

    vi.stubGlobal("window", undefined);
    expect(loadLegacyBookmarks()).toEqual([]);
    expect(() => clearLegacyBookmarks()).not.toThrow();
  });
});
