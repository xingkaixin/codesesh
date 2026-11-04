import { createQueryWrapper } from "../../test/query-wrapper";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { SearchResult, SessionHead } from "@codesesh/contract";
import { SearchResultsPanel } from "./SearchResultsPanel";

afterEach(cleanup);

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
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
      { wrapper: createQueryWrapper().Wrapper },
    ),
    props,
  };
}

describe("SearchResultsPanel", () => {
  it("renders safe result snippets and opens the selected result", () => {
    const snippet = '<script>alert("x")</script><mark>literal</mark> needle & more';
    const highlightStart = snippet.indexOf("needle");
    const results: SearchResult[] = [
      {
        reference: { agentName: "Codex", sessionId: "s1" },
        session: makeSession("s1", {
          display_title: "Renamed session",
          smart_tags: ["bugfix"],
        }),
        snippet,
        snippetHighlights: [{ start: highlightStart, end: highlightStart + "needle".length }],
        matchType: "title",
      },
      {
        reference: { agentName: "Other", sessionId: "s2" },
        session: makeSession("s2"),
        snippet: "",
        snippetHighlights: [],
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
    expect(Array.from(container.querySelectorAll("mark"), (node) => node.textContent)).toEqual([
      "needle",
    ]);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain(
      '<script>alert("x")</script><mark>literal</mark> needle & more',
    );

    const firstLink = screen.getByText("Renamed session").closest("a");
    const selectedTitle = screen
      .getAllByText("Session s2")
      .find((element) => element.tagName === "H2");
    const selectedLink = selectedTitle?.closest("a");
    expect(firstLink?.getAttribute("href")).toBe("/codex/s1");
    expect(firstLink?.getAttribute("data-selected")).toBeNull();
    expect(selectedLink?.getAttribute("data-selected")).toBe("true");
    fireEvent.click(selectedLink!);
    expect(onOpenResult).toHaveBeenCalledOnce();
    expect(registerResultRef).toHaveBeenCalledWith("codex/s1", expect.any(HTMLAnchorElement));
    expect(registerResultRef).toHaveBeenCalledWith("other/s2", expect.any(HTMLAnchorElement));
  });
});

it("links message matches to their source position", () => {
  renderPanel({
    status: "loaded",
    results: [
      {
        reference: { sourceNodeId: "remote", agentName: "codex", sessionId: "s1" },
        session: makeSession("s1"),
        snippet: "needle",
        snippetHighlights: [],
        matchType: "tool_output",
        messageIndex: 42,
      },
    ],
  });
  expect(
    screen
      .getByRole("heading", { level: 2, name: "Session s1" })
      .closest("a")
      ?.getAttribute("href"),
  ).toBe("/nodes/remote/codex/s1#message-42");
  const preview = screen.getByRole("complementary", { name: "Result preview" });
  expect(
    within(preview)
      .getByRole("link", { name: /Open session/ })
      .getAttribute("href"),
  ).toBe("/nodes/remote/codex/s1#message-42");
});

it("keeps matching session IDs on different sources distinct", () => {
  const results: SearchResult[] = ["local", "worker-one"].map((sourceNodeId) => {
    const reference = { sourceNodeId, agentName: "codex", sessionId: "same" };
    return {
      reference,
      session: makeSession("same", { reference }),
      snippet: "needle",
      snippetHighlights: [],
      matchType: "assistant_reply",
    };
  });
  const { props } = renderPanel({ status: "loaded", results });
  const local = screen.getAllByRole("heading", { level: 2, name: "Session same" })[0]!.closest("a");
  const remote = screen.getByText("Source: worker-one").closest("a");
  expect(local?.getAttribute("href")).toBe("/codex/same");
  expect(remote?.getAttribute("href")).toBe("/nodes/worker-one/codex/same");
  expect(props.registerResultRef).toHaveBeenCalledWith("codex/same", local);
  expect(props.registerResultRef).toHaveBeenCalledWith("@worker-one/codex/same", remote);
});
