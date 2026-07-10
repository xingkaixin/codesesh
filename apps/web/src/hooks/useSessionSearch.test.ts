import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SearchResult, SessionHead } from "../lib/api";
import type { SessionIndexes } from "../lib/session-indexes";
import { getProjectIdentityKey } from "../lib/projects";
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

// Characterization: pins the CURRENT local ("recent") search path -- the
// third re-implementation of recent-session filtering, alongside
// packages/cli/src/api/handlers.ts's recentSearchSessions and core's
// searchSessions("", ...) empty-query branch. Not a spec: asserts what the
// hook does today.
describe("useSessionSearch (characterization: local recent path)", () => {
  const projectApp = {
    kind: "git_remote" as const,
    key: "github.com/acme/app",
    displayName: "app",
  };
  const projectOther = {
    kind: "git_remote" as const,
    key: "github.com/acme/other",
    displayName: "other",
  };

  function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
    return {
      id,
      slug: `claudecode/${id}`,
      title: `Session ${id}`,
      directory: `/repo/${id}`,
      time_created: 0,
      time_updated: 0,
      stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
      ...overrides,
    } as SessionHead;
  }

  function buildIndexes(sessions: SessionHead[]): SessionIndexes {
    const byAgent = new Map<string, SessionHead[]>();
    const byProjectIdentityKey = new Map<string, SessionHead[]>();
    for (const session of sessions) {
      const agentKey = session.slug.split("/")[0]!.toLowerCase();
      byAgent.set(agentKey, [...(byAgent.get(agentKey) ?? []), session]);
      if (session.project_identity) {
        const key = getProjectIdentityKey(session.project_identity);
        byProjectIdentityKey.set(key, [...(byProjectIdentityKey.get(key) ?? []), session]);
      }
    }
    return {
      byAgent,
      byProjectIdentityKey,
      projectOptions: [],
      sessionsByActivity: sessions,
    } as unknown as SessionIndexes;
  }

  const sBugfixApp = makeSession("s-bugfix-app", {
    slug: "claudecode/s-bugfix-app",
    smart_tags: ["bugfix"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0.5 },
  });
  const sFeatureApp = makeSession("s-feature-app", {
    slug: "claudecode/s-feature-app",
    smart_tags: ["feature-dev"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 2 },
  });
  const sBugfixOther = makeSession("s-bugfix-other", {
    slug: "codex/s-bugfix-other",
    smart_tags: ["bugfix"],
    project_identity: projectOther,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 5 },
  });

  it("usesServerSearch stays false with no text and only agent/tag/cost filters", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() =>
      result.current.setSearchFilters({ agent: "claudecode", tag: "bugfix", costRange: "paid" }),
    );
    expect(result.current.usesServerSearch).toBe(false);
  });

  it("usesServerSearch becomes true once a tool filter is set, even with no query text", () => {
    const indexes = buildIndexes([sBugfixApp]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => result.current.setSearchFilters({ tool: "bash" }));
    expect(result.current.usesServerSearch).toBe(true);
  });

  it("usesServerSearch becomes true once a fileKind filter is set, even with no query text", () => {
    const indexes = buildIndexes([sBugfixApp]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => result.current.setSearchFilters({ fileKind: "edit" }));
    expect(result.current.usesServerSearch).toBe(true);
  });

  it("filters the local recent path by agent + tag, shaping snippets as 'Recent session · <directory>'", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => {
      result.current.setSearchFilters({ agent: "claudecode", tag: "bugfix" });
      result.current.openSearch();
    });

    expect(result.current.searchResults).toEqual([
      {
        agentName: "claudecode",
        session: sBugfixApp,
        snippet: `Recent session · ${sBugfixApp.directory}`,
        matchType: "recent",
      },
    ]);
  });

  it("filters the local recent path by project identity", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => {
      result.current.setSearchFilters({
        project: { kind: projectOther.kind, key: projectOther.key },
      });
      result.current.openSearch();
    });

    expect(result.current.searchResults.map((r) => r.session.id)).toEqual(["s-bugfix-other"]);
  });

  it("filters the local recent path by costRange (>= costMin, not strictly greater)", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => {
      result.current.setSearchFilters({ costRange: "one_plus" });
      result.current.openSearch();
    });

    // one_plus = costMin 1; sBugfixApp (0.5) is excluded, the other two (2, 5) pass.
    expect(result.current.searchResults.map((r) => r.session.id).sort()).toEqual(
      ["s-feature-app", "s-bugfix-other"].sort(),
    );
  });

  it("caps the local recent path at 50 results", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      makeSession(`s-many-${index}`, {
        slug: `claudecode/s-many-${index}`,
        smart_tags: ["bugfix"],
      }),
    );
    const indexes = buildIndexes(many);
    const { result } = renderHook(() => useSessionSearch(indexes));
    act(() => {
      result.current.setSearchFilters({ tag: "bugfix" });
      result.current.openSearch();
    });

    expect(result.current.searchResults).toHaveLength(50);
  });
});
