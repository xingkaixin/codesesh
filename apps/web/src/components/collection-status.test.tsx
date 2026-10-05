import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionSources } from "./collection-status";

afterEach(cleanup);

describe("CollectionSources", () => {
  it("keeps missing and failed sources visible while folding undiscovered sources", () => {
    const { container } = render(
      <CollectionSources
        sources={{
          codex: { presence: "available", complete: false },
          pi: { presence: "missing", complete: true },
          cursor: { presence: "not-found", complete: true },
          claudecode: { presence: "not-found", complete: false, error: "Permission denied" },
        }}
      />,
    );
    expect(screen.getByText("Older messages may not appear in search yet.")).toBeTruthy();
    expect(screen.getByText("Source no longer found")).toBeTruthy();
    expect(screen.getByText("Collection failed")).toBeTruthy();
    const disclosure = screen.getByText("Not discovered · 1").closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain("Cursor");
    expect(disclosure.textContent).not.toContain("Claude Code");
    expect(container.querySelector('[style*="/icon/agent/codex.svg"]')).toBeTruthy();
    fireEvent.click(screen.getByText("Not discovered · 1"));
    expect(disclosure.open).toBe(true);
  });

  it("does not infer absent agents from legacy or empty reports", () => {
    const { rerender } = render(<CollectionSources sources={undefined} />);
    expect(
      screen.getByText("Agent source details unavailable. Upgrade the collector to report them."),
    ).toBeTruthy();
    expect(screen.queryByText(/Not discovered/)).toBeNull();
    rerender(<CollectionSources sources={{}} />);
    expect(screen.getByText("No collection sources enabled.")).toBeTruthy();
  });

  it("distinguishes collected content from pending uploads and stale reports", () => {
    const sources = { codex: { presence: "available" as const, complete: true } };
    const { rerender } = render(<CollectionSources sources={sources} uploading />);
    expect(screen.getByText("Collected; uploads pending")).toBeTruthy();
    expect(screen.queryByText("Up to date")).toBeNull();
    rerender(<CollectionSources sources={sources} stale />);
    expect(screen.getByText("Last reported state; Worker status may have changed.")).toBeTruthy();
  });
});
