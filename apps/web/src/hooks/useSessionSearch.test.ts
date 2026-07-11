import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SearchResult } from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import * as api from "../lib/api";
import { useSessionSearch } from "./useSessionSearch";

vi.mock("../lib/api", () => ({
  fetchSearchResults: vi.fn(),
  logClientEvent: vi.fn(),
}));

const emptyIndexes = {
  byAgent: new Map(),
  byProjectIdentityKey: new Map(),
  projectOptions: [],
  sessionsByActivity: [],
} as unknown as SessionIndexes;

const serverResults = [
  { agentName: "cc", session: { id: "s1" }, snippet: "", matchType: "content" },
] as unknown as SearchResult[];

beforeEach(() => {
  vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionSearch", () => {
  it("starts idle with empty results", () => {
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    expect(result.current.searchMode).toBe(false);
    expect(result.current.searchState).toEqual({ status: "idle" });
    expect(result.current.searchResults).toEqual([]);
  });

  it("submitSearch activates the trimmed draft query", () => {
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    act(() => result.current.setDraftSearchQuery("  hello  "));
    act(() => result.current.submitSearch());

    expect(result.current.activeSearchQuery).toBe("hello");
    expect(result.current.searchMode).toBe(true);
  });

  it("runs a server search for an active query", async () => {
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: serverResults });
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    act(() => result.current.setDraftSearchQuery("hello"));
    act(() => result.current.submitSearch());

    await waitFor(() => expect(result.current.searchResults).toEqual(serverResults));
    expect(api.fetchSearchResults).toHaveBeenCalledWith("hello", expect.any(Object));
  });

  it("exposes a failed search state that can be retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchSearchResults).mockRejectedValueOnce(new Error("Search unavailable"));
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    act(() => result.current.setDraftSearchQuery("hello"));
    act(() => result.current.submitSearch());

    await waitFor(() =>
      expect(api.logClientEvent).toHaveBeenCalledWith(
        "search.error",
        expect.objectContaining({ error: "Search unavailable" }),
      ),
    );
    expect(result.current.searchState).toEqual({
      status: "failed",
      error: "Search unavailable",
    });

    vi.mocked(api.fetchSearchResults).mockResolvedValueOnce({ results: serverResults });
    await act(async () => result.current.retrySearch());
    await waitFor(() =>
      expect(result.current.searchState).toEqual({ status: "loaded", results: serverResults }),
    );
  });

  it("sends both project identity fields to server search", async () => {
    const indexes = {
      ...emptyIndexes,
      projectOptions: [
        {
          key: "git_remote:github.com/acme/app",
          identityKind: "git_remote",
          identityKey: "github.com/acme/app",
          label: "App",
          count: 1,
        },
      ],
    } as SessionIndexes;
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() =>
      result.current.setSearchFilters({
        project: { kind: "git_remote", key: "github.com/acme/app" },
      }),
    );
    act(() => result.current.setDraftSearchQuery("hello"));
    act(() => result.current.submitSearch());

    await waitFor(() =>
      expect(api.fetchSearchResults).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          projectKind: "git_remote",
          projectKey: "github.com/acme/app",
        }),
      ),
    );
  });

  it("closeSearch exits and clears the active query", () => {
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    act(() => result.current.setDraftSearchQuery("hello"));
    act(() => result.current.submitSearch());
    act(() => result.current.closeSearch());

    expect(result.current.searchMode).toBe(false);
    expect(result.current.activeSearchQuery).toBe("");
  });

  it("refresh re-fetches server results while searching", async () => {
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: serverResults });
    const { result } = renderHook(() => useSessionSearch(emptyIndexes));
    act(() => result.current.setDraftSearchQuery("hello"));
    act(() => result.current.submitSearch());
    await waitFor(() => expect(result.current.searchResults).toEqual(serverResults));

    const next = [
      { agentName: "cc", session: { id: "s2" }, snippet: "", matchType: "content" },
    ] as unknown as SearchResult[];
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: next });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.searchResults).toEqual(next);
  });
});
