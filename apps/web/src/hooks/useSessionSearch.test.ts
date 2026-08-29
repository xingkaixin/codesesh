import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SearchResult } from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import * as api from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
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

function makeSearchResult(id: string): SearchResult {
  return {
    reference: { agentName: "cc", sessionId: id },
    session: {
      reference: { agentName: "cc", sessionId: id },
      title: id,
      directory: "/workspace",
      time_created: 1,
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    },
    snippet: "",
    snippetHighlights: [],
    matchType: "assistant_reply",
  };
}

const serverResults = [makeSearchResult("s1")];

beforeEach(() => {
  vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSearch(indexes: SessionIndexes = emptyIndexes) {
  const { Wrapper } = createQueryWrapper();
  return renderHook(() => useSessionSearch(indexes), { wrapper: Wrapper });
}

describe("useSessionSearch", () => {
  it("starts idle with empty results", () => {
    const { result } = renderSearch();
    expect(result.current.searchMode).toBe(false);
    expect(result.current.searchState).toEqual({ status: "idle" });
    expect(result.current.searchResults).toEqual([]);
  });

  it("submitSearch activates the trimmed query", () => {
    const { result } = renderSearch();
    act(() => result.current.submitSearch("  hello  "));

    expect(result.current.activeSearchQuery).toBe("hello");
    expect(result.current.searchMode).toBe(true);
  });

  it("runs a server search for an active query", async () => {
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: serverResults });
    const { result } = renderSearch();
    act(() => result.current.submitSearch("hello"));

    await waitFor(() => expect(result.current.searchResults).toEqual(serverResults));
    expect(api.fetchSearchResults).toHaveBeenCalledWith("hello", expect.any(Object), {
      signal: expect.any(AbortSignal),
    });
  });

  it("exposes a failed search state that can be retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchSearchResults).mockRejectedValueOnce(new Error("Search unavailable"));
    const { result } = renderSearch();
    act(() => result.current.submitSearch("hello"));

    await waitFor(() =>
      expect(api.logClientEvent).toHaveBeenCalledWith(
        "search.error",
        expect.objectContaining({ error_name: "Error" }),
      ),
    );
    const errorData = vi
      .mocked(api.logClientEvent)
      .mock.calls.find(([event]) => event === "search.error")?.[1];
    expect(JSON.stringify(errorData)).not.toContain("Search unavailable");
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
    const { result } = renderSearch(indexes);
    act(() =>
      result.current.setSearchFilters({
        project: { kind: "git_remote", key: "github.com/acme/app" },
      }),
    );
    act(() => result.current.submitSearch("hello"));

    await waitFor(() =>
      expect(api.fetchSearchResults).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          projectKind: "git_remote",
          projectKey: "github.com/acme/app",
        }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it("closeSearch exits and clears the active query", () => {
    const { result } = renderSearch();
    act(() => result.current.submitSearch("hello"));
    act(() => result.current.closeSearch());

    expect(result.current.searchMode).toBe(false);
    expect(result.current.activeSearchQuery).toBe("");
  });

  it("refresh re-fetches server results while searching", async () => {
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: serverResults });
    const { result } = renderSearch();
    act(() => result.current.submitSearch("hello"));
    await waitFor(() => expect(result.current.searchResults).toEqual(serverResults));

    const next = [makeSearchResult("s2")];
    vi.mocked(api.fetchSearchResults).mockResolvedValue({ results: next });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.searchResults).toEqual(next));
  });
});
