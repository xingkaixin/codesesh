import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkRecord, BookmarkView, SessionHead } from "@codesesh/contract";
import * as api from "../lib/api";
import * as bookmarkUtils from "../lib/bookmarks";
import { createQueryWrapper } from "../test/query-wrapper";
import { useBookmarks } from "./useBookmarks";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", () => ({
  fetchBookmarks: vi.fn(),
  importBookmarks: vi.fn(),
  deleteBookmark: vi.fn(),
  upsertBookmark: vi.fn(),
  logClientEvent: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise legacy bookmark migration without depending on browser storage left by other tests.
vi.mock("../lib/bookmarks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bookmarks")>();
  return {
    ...actual,
    loadLegacyBookmarks: vi.fn(() => []),
    clearLegacyBookmarks: vi.fn(),
  };
});

function fact(id: string, bookmarkedAt = 1): BookmarkRecord {
  return {
    reference: { agentName: "cc", sessionId: id },
    bookmarkedAt,
  };
}

function session(id: string, updated = 1): SessionHead {
  return {
    reference: { agentName: "cc", sessionId: id },
    title: id,
    directory: "/d",
    time_created: 1,
    time_updated: updated,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function available(id: string, updated = 1): BookmarkView {
  return {
    ...fact(id),
    availability: "available",
    session: session(id, updated),
  };
}

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
  vi.mocked(api.upsertBookmark).mockResolvedValue({ bookmark: fact("saved") });
  vi.mocked(api.deleteBookmark).mockResolvedValue(undefined);
  vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBookmarks() {
  const { Wrapper } = createQueryWrapper();
  return renderHook(() => useBookmarks(), { wrapper: Wrapper });
}

describe("useBookmarks", () => {
  it("migrates legacy bookmark facts once without snapshot fields", async () => {
    const legacy = fact("legacy", 42);
    vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([legacy]);
    vi.mocked(api.importBookmarks).mockResolvedValueOnce({ bookmarks: [available("legacy")] });
    const { result } = renderBookmarks();

    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "legacy")).toBe(true));
    expect(vi.mocked(api.importBookmarks).mock.calls[0]?.[0]).toEqual([legacy]);
    expect(bookmarkUtils.clearLegacyBookmarks).toHaveBeenCalledOnce();
  });

  it("keeps legacy storage when migration fails", async () => {
    const error = new Error("migration failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(bookmarkUtils.loadLegacyBookmarks).mockReturnValue([fact("legacy")]);
    vi.mocked(api.importBookmarks).mockRejectedValueOnce(error);

    renderBookmarks();

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to migrate legacy bookmarks:", error),
    );
    expect(bookmarkUtils.clearLegacyBookmarks).not.toHaveBeenCalled();
  });

  it("persists overlapping toggles for the same bookmark in intent order", async () => {
    const addRequest = deferred<void>();
    const deleteRequest = deferred<void>();
    const completionOrder: string[] = [];
    let serverBookmarked = false;
    vi.mocked(api.fetchBookmarks).mockImplementation(async () => ({
      bookmarks: serverBookmarked ? [available("racy")] : [],
    }));
    vi.mocked(api.upsertBookmark).mockImplementationOnce(async () => {
      await addRequest.promise;
      serverBookmarked = true;
      completionOrder.push("add");
      return { bookmark: fact("racy") };
    });
    vi.mocked(api.deleteBookmark).mockImplementationOnce(async () => {
      await deleteRequest.promise;
      serverBookmarked = false;
      completionOrder.push("delete");
    });
    const { result } = renderBookmarks();
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalledOnce());

    act(() => result.current.toggleBookmark(available("racy")));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "racy")).toBe(true));
    act(() => result.current.toggleBookmark(available("racy")));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "racy")).toBe(false));
    expect(api.deleteBookmark).not.toHaveBeenCalled();

    addRequest.resolve();
    await addRequest.promise;
    await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledOnce());
    expect(result.current.isSessionBookmarked("cc", "racy")).toBe(false);

    deleteRequest.resolve();
    await deleteRequest.promise;
    await waitFor(() => expect(completionOrder).toEqual(["add", "delete"]));
    expect(serverBookmarked).toBe(false);
    expect(result.current.isSessionBookmarked("cc", "racy")).toBe(false);
  });

  it("keeps successful bookmarks confirmed while another write is pending", async () => {
    const firstRequest = deferred<void>();
    const secondRequest = deferred<void>();
    let serverBookmarks: BookmarkView[] = [];
    vi.mocked(api.fetchBookmarks).mockImplementation(async () => ({ bookmarks: serverBookmarks }));
    vi.mocked(api.upsertBookmark)
      .mockImplementationOnce(async () => {
        await firstRequest.promise;
        serverBookmarks = [available("first")];
        return { bookmark: fact("first") };
      })
      .mockImplementationOnce(async () => {
        await secondRequest.promise;
        serverBookmarks = [available("second"), ...serverBookmarks];
        return { bookmark: fact("second") };
      });
    vi.mocked(api.deleteBookmark).mockImplementationOnce(async () => {
      serverBookmarks = serverBookmarks.filter(({ reference }) => reference.sessionId !== "first");
    });
    const { result } = renderBookmarks();
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalledOnce());

    act(() => result.current.toggleBookmark(available("first")));
    act(() => result.current.toggleBookmark(available("second")));
    await waitFor(() => expect(api.upsertBookmark).toHaveBeenCalledTimes(1));

    firstRequest.resolve();
    await waitFor(() => expect(api.upsertBookmark).toHaveBeenCalledTimes(2));
    expect(result.current.isSessionBookmarked("cc", "first")).toBe(true);
    expect(result.current.isSessionBookmarked("cc", "second")).toBe(true);

    act(() => result.current.toggleBookmark(available("first")));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "first")).toBe(false));
    secondRequest.resolve();

    await waitFor(() =>
      expect(api.deleteBookmark).toHaveBeenCalledWith({
        agentName: "cc",
        sessionId: "first",
      }),
    );
    await waitFor(() => expect(result.current.bookmarkedSessions).toEqual([available("second")]));
    expect(api.upsertBookmark).toHaveBeenCalledTimes(2);
  });

  it("rolls back only the failed bookmark while another toggle is pending", async () => {
    const failedRequest = deferred<void>();
    const successfulRequest = deferred<void>();
    const error = new Error("first write failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let serverBookmarks: BookmarkView[] = [];
    vi.mocked(api.fetchBookmarks).mockImplementation(async () => ({
      bookmarks: serverBookmarks,
    }));
    vi.mocked(api.upsertBookmark)
      .mockImplementationOnce(async () => {
        await failedRequest.promise;
        return { bookmark: fact("first") };
      })
      .mockImplementationOnce(async () => {
        await successfulRequest.promise;
        serverBookmarks = [available("second")];
        return { bookmark: fact("second") };
      });
    const { result } = renderBookmarks();
    await waitFor(() => expect(api.fetchBookmarks).toHaveBeenCalledOnce());

    act(() => result.current.toggleBookmark(available("first")));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "first")).toBe(true));
    act(() => result.current.toggleBookmark(available("second")));
    await waitFor(() => expect(result.current.isSessionBookmarked("cc", "second")).toBe(true));
    expect(api.upsertBookmark).toHaveBeenCalledTimes(1);

    failedRequest.reject(error);
    await failedRequest.promise.catch(() => undefined);
    await waitFor(() => expect(api.upsertBookmark).toHaveBeenCalledTimes(2));
    expect(result.current.isSessionBookmarked("cc", "first")).toBe(false);
    expect(result.current.isSessionBookmarked("cc", "second")).toBe(true);

    successfulRequest.resolve();
    await successfulRequest.promise;
    await waitFor(() => expect(result.current.bookmarkedSessions).toEqual(serverBookmarks));
    expect(consoleError).toHaveBeenCalledWith("Failed to toggle bookmark:", error);
  });
});
