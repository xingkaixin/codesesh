import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BookmarkedSessionSnapshot, SessionHead } from "../lib/api";
import * as api from "../lib/api";
import * as bookmarkUtils from "../lib/bookmarks";
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
    clearLegacyBookmarks: vi.fn(),
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

const session = (id: string): SessionHead => ({
  id,
  slug: `cc/${id}`,
  title: id,
  directory: "/d",
  time_created: 1,
  stats: {
    message_count: 1,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [] });
  vi.mocked(api.importBookmarks).mockResolvedValue({ bookmarks: [] });
  vi.mocked(api.upsertBookmark).mockResolvedValue(undefined as never);
  vi.mocked(api.deleteBookmark).mockResolvedValue(undefined as never);
  vi.mocked(bookmarkUtils.mergeBookmarksWithSessions).mockImplementation((prev) => prev);
  vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([]);
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

  it("refreshes bookmarks and reports load failures", async () => {
    const error = new Error("offline");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchBookmarks).mockRejectedValueOnce(error);
    const { result } = renderHook(() => useBookmarks([]));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to load bookmarks:", error),
    );

    vi.mocked(api.fetchBookmarks).mockResolvedValueOnce({ bookmarks: [snap("refreshed")] });
    await act(() => result.current.refresh());
    expect(result.current.isSessionBookmarked("cc", "refreshed")).toBe(true);

    vi.mocked(api.fetchBookmarks).mockRejectedValueOnce(error);
    await act(() => result.current.refresh());
    expect(consoleError).toHaveBeenLastCalledWith("Failed to load bookmarks:", error);
  });

  it("does not apply the initial response after unmount", async () => {
    const request = deferred<{ bookmarks: BookmarkedSessionSnapshot[] }>();
    vi.mocked(api.fetchBookmarks).mockReturnValueOnce(request.promise);
    const { unmount } = renderHook(() => useBookmarks([]));

    unmount();
    request.resolve({ bookmarks: [snap("late")] });
    await request.promise;

    expect(api.fetchBookmarks).toHaveBeenCalledOnce();
  });

  it("synchronizes changed bookmark snapshots with the server", async () => {
    vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [snap("s1", 1)] });
    const updated = snap("s1", 2);
    vi.mocked(bookmarkUtils.mergeBookmarksWithSessions).mockImplementation((previous, sessions) =>
      previous.length > 0 && sessions.length > 0 ? [updated] : previous,
    );
    const { result, rerender } = renderHook(({ sessions }) => useBookmarks(sessions), {
      initialProps: { sessions: [] as SessionHead[] },
    });
    await waitFor(() => expect(result.current.bookmarkedSessions).toHaveLength(1));

    rerender({ sessions: [session("s1")] });
    await waitFor(() => expect(api.importBookmarks).toHaveBeenCalledOnce());

    expect(api.importBookmarks).toHaveBeenCalledWith([
      expect.not.objectContaining({ bookmarked_at: expect.anything() }),
    ]);
    expect(result.current.bookmarkedSessions[0]?.time_updated).toBe(2);
  });

  it("reports snapshot sync failures while mounted", async () => {
    const error = new Error("sync failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchBookmarks).mockResolvedValue({ bookmarks: [snap("s1")] });
    vi.mocked(api.importBookmarks).mockRejectedValueOnce(error);
    vi.mocked(bookmarkUtils.mergeBookmarksWithSessions).mockImplementation((previous, sessions) =>
      previous.length > 0 && sessions.length > 0 ? [snap("s1", 2)] : previous,
    );
    const { result, rerender } = renderHook(({ sessions }) => useBookmarks(sessions), {
      initialProps: { sessions: [] as SessionHead[] },
    });
    await waitFor(() => expect(result.current.bookmarkedSessions).toHaveLength(1));

    rerender({ sessions: [session("s1")] });

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to sync bookmark snapshots:", error),
    );
  });

  it("migrates legacy bookmarks once", async () => {
    const legacy = snap("legacy");
    vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([legacy]);
    vi.mocked(api.importBookmarks).mockResolvedValueOnce({ bookmarks: [legacy] });
    const { result } = renderHook(() => useBookmarks([]));

    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "legacy")).toBe(true));
    expect(api.importBookmarks).toHaveBeenCalledWith([
      expect.not.objectContaining({ bookmarked_at: expect.anything() }),
    ]);
    expect(bookmarkUtils.clearLegacyBookmarks).toHaveBeenCalledOnce();
  });

  it("reports legacy migration failures", async () => {
    const error = new Error("migration failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([snap("legacy")]);
    vi.mocked(api.importBookmarks).mockRejectedValueOnce(error);

    renderHook(() => useBookmarks([]));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to migrate legacy bookmarks:", error),
    );
    expect(bookmarkUtils.clearLegacyBookmarks).not.toHaveBeenCalled();
  });

  it("rolls back an optimistic toggle when persistence fails", async () => {
    const error = new Error("write failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.upsertBookmark).mockRejectedValueOnce(error);
    const { result } = renderHook(() => useBookmarks([]));
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalled());

    act(() => result.current.toggleBookmark(snap("failed")));
    expect(result.current.isSessionBookmarked("cc", "failed")).toBe(true);

    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "failed")).toBe(false));
    expect(consoleError).toHaveBeenCalledWith("Failed to toggle bookmark:", error);
    expect(api.logClientEvent).toHaveBeenCalledWith("bookmark.add", {
      agent: "cc",
      session: "failed",
    });
  });

  it("converts live sessions before toggling bookmarks", async () => {
    const { result } = renderHook(() => useBookmarks([]));
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalled());

    act(() => result.current.toggleSessionBookmark(session("live"), "cc"));

    expect(api.upsertBookmark).toHaveBeenCalledWith(
      expect.objectContaining({ agentKey: "cc", sessionId: "live", fullPath: "cc/live" }),
    );
  });
});
