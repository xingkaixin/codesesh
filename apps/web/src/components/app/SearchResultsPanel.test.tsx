import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { SearchResult, SessionHead } from "../../lib/api";
import { SearchResultsPanel } from "./SearchResultsPanel";

afterEach(cleanup);

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: `Session ${id}`,
    directory: "/workspace",
    time_created: 1,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function renderPanel(
  state: Parameters<typeof SearchResultsPanel>[0]["state"],
  overrides: Partial<Parameters<typeof SearchResultsPanel>[0]> = {},
) {
  const props = {
    query: "hello",
    state,
    agentNameMap: new Map<string, string>(),
    agents: [],
    projects: [],
    filters: {},
    onChangeFilters: vi.fn(),
    onOpenResult: vi.fn(),
    onRetry: vi.fn(),
    selectedIndex: 0,
    registerResultRef: vi.fn(),
    ...overrides,
  };

  return {
    ...render(
      <MemoryRouter>
        <SearchResultsPanel {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

describe("SearchResultsPanel", () => {
  it("shows a recoverable search error", () => {
    const onRetry = vi.fn();

    renderPanel(
      { status: "failed", error: "Search unavailable" },
      {
        onRetry,
      },
    );

    expect(
      screen.getByText("Search unavailable. Check the server connection, then try again."),
    ).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry Search" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("shows loading feedback without empty-state content", () => {
    const { container } = renderPanel({ status: "loading" });

    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("distinguishes empty recent sessions from empty query matches", () => {
    const first = renderPanel({ status: "loaded", results: [] }, { query: "" });
    expect(screen.getByText("No recent sessions")).toBeTruthy();
    expect(screen.queryByText(/^Query:/)).toBeNull();
    first.unmount();

    renderPanel({ status: "loaded", results: [] }, { query: "needle" });
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.getByText("Query: needle")).toBeTruthy();
  });

  it("renders safe result snippets and opens the selected result", () => {
    const results: SearchResult[] = [
      {
        agentName: "Codex",
        session: makeSession("s1", {
          display_title: "Renamed session",
          smart_tags: ["bugfix"],
        }),
        snippet: '<script>alert("x")</script><mark>needle</mark> & more',
        matchType: "title",
      },
      {
        agentName: "Other",
        session: makeSession("s2"),
        snippet: "",
        matchType: "file_path",
      },
    ];
    const onOpenResult = vi.fn();
    const registerResultRef = vi.fn();

    const { container } = renderPanel(
      { status: "loaded", results },
      {
        query: "needle",
        agentNameMap: new Map([["codex", "Codex CLI"]]),
        selectedIndex: 1,
        onOpenResult,
        registerResultRef,
      },
    );

    expect(screen.getByText("Codex CLI")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("File path")).toBeTruthy();
    expect(screen.getByText("Renamed session")).toBeTruthy();
    expect(screen.getAllByText("bugfix").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.getByText("needle").tagName).toBe("MARK");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("x")</script>needle & more');

    const firstLink = screen.getByText("Renamed session").closest("a");
    const selectedTitle = screen
      .getAllByText("Session s2")
      .find((element) => element.tagName === "H2");
    const selectedLink = selectedTitle?.closest("a");
    expect(firstLink?.getAttribute("href")).toBe("/codex/s1");
    expect(firstLink?.className).toContain("border-[var(--console-border)]");
    expect(selectedLink?.className).toContain("border-[var(--console-border-strong)]");
    fireEvent.click(selectedLink!);
    expect(onOpenResult).toHaveBeenCalledOnce();
    expect(registerResultRef).toHaveBeenCalledWith("Codex/s1", expect.any(HTMLAnchorElement));
    expect(registerResultRef).toHaveBeenCalledWith("Other/s2", expect.any(HTMLAnchorElement));
  });
});
