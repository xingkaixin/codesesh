import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionIdentity,
  type AgentInfo,
  type SearchResult,
  type SessionHead,
} from "@codesesh/contract";
import { createAgentCatalog } from "../lib/agents";
import { createQueryClient } from "../lib/query-client";
import { buildSessionIndexes } from "../lib/session-indexes";
import { AppRouteContent } from "../components/app/AppRouteContent";
import type { SearchControlsHandle } from "../components/app/SearchControls";
import { useSessionSearch } from "./useSessionSearch";

beforeAll(async () => {
  await import("../components/app/SearchResultsPanel");
});

beforeEach(() => {
  vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AGENTS: AgentInfo[] = [
  { name: "claudecode", displayName: "Claude Code", count: 1, resumeCommandPrefix: null },
  { name: "codex", displayName: "Codex", count: 1, resumeCommandPrefix: null },
];

function makeSession(
  id: string,
  agentName: string,
  projectKey: string,
  displayName: string,
): SessionHead {
  return {
    ...createSessionIdentity({ agentName, sessionId: id }),
    title: `Session ${id}`,
    directory: `/repo/${displayName}`,
    time_created: 1,
    time_updated: 2,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    project_identity: {
      kind: "git_remote",
      key: projectKey,
      displayName,
    },
  };
}

const SESSION_ALPHA = makeSession("s-alpha", "claudecode", "github.com/acme/alpha", "alpha");
const SESSION_BETA = makeSession("s-beta", "codex", "github.com/acme/beta", "beta");
const SESSION_INDEXES = buildSessionIndexes([SESSION_ALPHA, SESSION_BETA], AGENTS);
const AGENT_CATALOG = createAgentCatalog(AGENTS);

function SearchHarness() {
  const location = useLocation();
  const controlsRef = useRef<SearchControlsHandle>(null);
  const search = useSessionSearch(SESSION_INDEXES, null);

  return (
    <div>
      <span data-testid="location-url">
        {location.pathname}
        {location.search}
        {location.hash}
      </span>
      <span data-testid="location-state">{JSON.stringify(location.state ?? null)}</span>
      <button type="button" onClick={search.openSearch}>
        Open Search
      </button>
      <AppRouteContent
        load={{ loading: false, error: null, retry: vi.fn() }}
        route={{
          mode: "root",
          activeAgentKey: null,
          activeSessionId: null,
          agentCatalog: AGENT_CATALOG,
          projectCount: 2,
          overview: { window: null, rangePreset: "30d" },
        }}
        search={{
          active: search.searchMode,
          query: search.activeSearchQuery,
          state: search.searchState,
          agentNameMap: AGENT_CATALOG.displayNameByKey,
          agents: AGENTS,
          projectOptions: search.projectOptions,
          projectDisplayNames: search.projectDisplayNames,
          filters: search.searchFilters,
          onChangeFilters: search.setSearchFilters,
          onClose: search.closeSearch,
          onRetry: search.retrySearch,
          selectedIndex: search.selectedSearchIndex,
          onSelectIndex: search.selectSearchIndex,
          registerResultRef: search.registerResultRef,
          controls: controlsRef,
          onSubmit: search.submitSearch,
        }}
      />
    </div>
  );
}

describe("useSessionSearch URL persistence and filter UX", () => {
  it("commits typed draft query when clicking a filter chip and restores search on Back", async () => {
    const searchUrls: string[] = [];
    const results: SearchResult[] = [
      {
        reference: SESSION_ALPHA.reference,
        session: SESSION_ALPHA,
        snippet: "alpha panic hit",
        snippetHighlights: [{ start: 6, end: 11 }],
        matchType: "assistant_reply",
        messageIndex: 3,
      },
      {
        reference: SESSION_BETA.reference,
        session: SESSION_BETA,
        snippet: "beta panic hit",
        snippetHighlights: [{ start: 5, end: 10 }],
        matchType: "tool_output",
        messageIndex: 7,
      },
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/search") {
        searchUrls.push(url.search);
        const agent = url.searchParams.get("agent");
        const projectKey = url.searchParams.get("projectKey");
        const filtered = results.filter((item) => {
          if (agent && item.reference.agentName !== agent) return false;
          if (projectKey && item.session.project_identity?.key !== projectKey) return false;
          return true;
        });
        return Response.json({ results: filtered });
      }
      return Response.json({});
    });

    const router = createMemoryRouter([{ path: "*", Component: SearchHarness }], {
      initialEntries: ["/"],
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Search" }));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "stale" } });
    fireEvent.submit(input.closest("form")!);

    await screen.findByRole("heading", { level: 2, name: "Session s-alpha" });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    // Type a new draft query without pressing Enter, then click an Agent filter chip.
    fireEvent.change(input, { target: { value: "panic" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(screen.getByTestId("location-url").textContent).toBe("/?q=panic&agent=codex");
    });
    expect(
      searchUrls.some((search) => search.includes("q=panic") && search.includes("agent=codex")),
    ).toBe(true);
    expect(
      searchUrls.some((search) => search.includes("q=stale") && search.includes("agent=codex")),
    ).toBe(false);

    // Select project alpha (or beta) and verify the other project chip remains available.
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "beta" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    await waitFor(() => {
      expect(screen.getByTestId("location-url").textContent).toContain(
        "projectKey=github.com%2Facme%2Fbeta",
      );
    });
    expect(screen.getByRole("button", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "beta" })).toBeTruthy();

    // Open the matched result, then press browser Back and verify search state is restored.
    const resultLink = screen
      .getByRole("heading", { level: 2, name: "Session s-beta" })
      .closest("a")!;
    fireEvent.click(resultLink);

    await waitFor(() => {
      expect(screen.getByTestId("location-url").textContent).toBe("/codex/s-beta#message-7");
      expect(screen.getByTestId("location-state").textContent).toBe(
        JSON.stringify({ searchQuery: "panic" }),
      );
    });
    expect(screen.queryByRole("searchbox")).toBeNull();

    await act(async () => {
      await router.navigate(-1);
    });

    const restoredInput = await screen.findByRole<HTMLInputElement>("searchbox");
    expect(restoredInput.value).toBe("panic");
    expect(screen.getByTestId("location-url").textContent).toContain("q=panic");
    expect(screen.getByTestId("location-url").textContent).toContain(
      "projectKey=github.com%2Facme%2Fbeta",
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Session s-beta" })).toBeTruthy();
  });
});
