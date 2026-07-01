import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BookmarkedSessionSnapshot } from "../lib/api";
import * as api from "../lib/api";
import { useBookmarks } from "./useBookmarks";

vi.mock("../lib/api", () => ({
  fetchBookmarks: vi.fn(),
  importBookmarks: vi.fn(),
  deleteBookmark: vi.fn(),
  upsertBookmark: vi.fn(),
  logClientEvent: vi.fn(),
}));

vi.mock("../lib/bookmarks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bookmarks")>();
  return {
    ...actual,
    mergeBookmarksWithSessions: vi.fn((prev) => prev),
    loadLegacyBookmarks: vi.fn(() => []),
  };
});

const snap = (id: string, updated = 1): BookmarkedSessionSnapshot =>
  ({
    agentKey: "cc",
    sessionId: id,
    fullPath: `cc/${id}`,
    title: id,
    directory: "/d",
    time_created: 1,
    time_updated: updated,
    stats: {},
    bookmarked_at: 0,
  }) as unknown as BookmarkedSessionSnapshot;

beforeEach(() => {
  vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [] });
  vi.mocked(api.importBookmarks).mockResolvedValue({ bookmarks: [] });
  vi.mocked(api.upsertBookmark).mockResolvedValue(undefined as never);
  vi.mocked(api.deleteBookmark).mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useBookmarks", () => {
  it("loads bookmarks on mount", async () => {
    vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [snap("s1")] });
    const { result } = renderHook(() => useBookmarks([]));

    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "s1")).toBe(true));
  });

  it("toggleBookmark adds optimistically and calls upsert", async () => {
    const { result } = renderHook(() => useBookmarks([]));
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalled());

    act(() => result.current.toggleBookmark(snap("s2")));

    expect(result.current.isSessionBookmarked("cc", "s2")).toBe(true);
    expect(api.upsertBookmark).toHaveBeenCalledOnce();
  });

  it("toggleBookmark removes an existing bookmark and calls delete", async () => {
    vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [snap("s3")] });
    const { result } = renderHook(() => useBookmarks([]));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "s3")).toBe(true));

    act(() => result.current.toggleBookmark(snap("s3")));

    expect(result.current.isSessionBookmarked("cc", "s3")).toBe(false);
    expect(api.deleteBookmark).toHaveBeenCalledWith("cc", "s3");
  });

  it("bookmarkedSessions is sorted by most-recent activity", async () => {
    vi.mocked(api.fetchBookmarks).mockResolvedValue({
      bookmarks: [snap("old", 10), snap("new", 20)],
    });
    const { result } = renderHook(() => useBookmarks([]));

    await waitFor(() => expect(result.current.bookmarkedSessions).toHaveLength(2));
    expect(result.current.bookmarkedSessions[0]?.sessionId).toBe("new");
  });
});
