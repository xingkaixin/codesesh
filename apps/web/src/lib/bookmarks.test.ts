import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLegacyBookmarks, loadLegacyBookmarks } from "./bookmarks";

describe("bookmarks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
