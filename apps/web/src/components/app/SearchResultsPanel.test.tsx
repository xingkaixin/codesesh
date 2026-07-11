import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchResultsPanel } from "./SearchResultsPanel";

afterEach(cleanup);

describe("SearchResultsPanel", () => {
  it("shows a recoverable search error", () => {
    const onRetry = vi.fn();

    render(
      <SearchResultsPanel
        query="hello"
        state={{ status: "failed", error: "Search unavailable" }}
        agentNameMap={new Map()}
        agents={[]}
        projects={[]}
        filters={{}}
        onChangeFilters={vi.fn()}
        onOpenResult={vi.fn()}
        onRetry={onRetry}
        selectedIndex={0}
        registerResultRef={vi.fn()}
      />,
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
});
