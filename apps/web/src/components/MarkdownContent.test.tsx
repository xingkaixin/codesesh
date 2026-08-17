import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

function marks(container: HTMLElement): string[] {
  return [...container.querySelectorAll("mark")].map((mark) => mark.textContent ?? "");
}

describe("MarkdownContent search highlighting", () => {
  it("CS-135: keeps only the current query highlighted", () => {
    const view = render(<MarkdownContent text="Alpha Beta" />);
    expect(marks(view.container)).toEqual([]);

    view.rerender(<MarkdownContent text="Alpha Beta" highlightQuery="Alpha" />);
    expect(marks(view.container)).toEqual(["Alpha"]);

    view.rerender(<MarkdownContent text="Alpha Beta" highlightQuery="Beta" />);
    expect(marks(view.container)).toEqual(["Beta"]);

    view.rerender(<MarkdownContent text="Alpha Beta" highlightQuery="" />);
    expect(marks(view.container)).toEqual([]);

    view.rerender(<MarkdownContent text="Alpha Beta" highlightQuery="Alpha" />);
    expect(marks(view.container)).toEqual(["Alpha"]);
    expect(view.container.textContent).toBe("Alpha Beta");
  });

  it("CS-135: highlights every term of a multi-term query", () => {
    const view = render(<MarkdownContent text="Alpha Beta Gamma" highlightQuery="gamma alpha" />);

    expect(marks(view.container)).toEqual(["Alpha", "Gamma"]);
  });

  it("CS-135: treats a quoted phrase as one term", () => {
    const view = render(
      <MarkdownContent text="the quick brown fox" highlightQuery='"quick brown"' />,
    );

    expect(marks(view.container)).toEqual(["quick brown"]);
  });

  it("CS-135: highlights inside emphasis and link text", () => {
    const view = render(
      <MarkdownContent
        text="**Alpha** and [Alpha docs](https://example.com)"
        highlightQuery="alpha"
      />,
    );

    expect(marks(view.container)).toEqual(["Alpha", "Alpha"]);
    expect(view.container.querySelector("strong mark")).not.toBeNull();
  });

  it("CS-135: leaves code and preformatted text untouched", () => {
    const view = render(
      <MarkdownContent text={"`alpha()` and\n\n```\nalpha\n```"} highlightQuery="alpha" />,
    );

    expect(marks(view.container)).toEqual([]);
  });

  it("CS-135: does not disturb a mark written in the markdown itself", () => {
    const view = render(<MarkdownContent text="plain text" highlightQuery="missing" />);

    expect(marks(view.container)).toEqual([]);
    expect(view.container.textContent).toBe("plain text");
  });
});

describe("CS-136: markdown media stays local", () => {
  it.each([
    ["remote https", "https://tracker.example.com/pixel.png"],
    ["protocol relative", "//tracker.example.com/pixel.png"],
  ])("does not emit a requestable src for a %s image", (_name, url) => {
    const view = render(<MarkdownContent text={`![shot](${url})`} />);

    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(view.container.textContent).toContain("Remote image not loaded");
    expect(view.container.textContent).toContain("shot");
  });

  it("renders inline image data", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const view = render(<MarkdownContent text={`![local](${src})`} />);

    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(src);
  });

  it("renders a same-origin asset path", () => {
    const view = render(<MarkdownContent text="![asset](/api/assets/a.png)" />);

    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      `${window.location.origin}/api/assets/a.png`,
    );
  });
});

describe("MarkdownContent render budget", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("bounds the initial parse and preserves access to a large message", async () => {
    const text = Array.from(
      { length: 3_000 },
      (_, index) => `## Entry ${index}\n\n${"payload ".repeat(12)}`,
    ).join("\n\n");
    const view = render(<MarkdownContent text={text} />);

    const initialRenderedCharacters = view.container.textContent?.length ?? 0;
    expect(view.queryByText("Entry 2999")).toBeNull();
    expect(initialRenderedCharacters).toBeLessThan(40_000);

    fireEvent.click(view.getByRole("button", { name: "Render more content" }));
    expect(view.container.textContent?.length ?? 0).toBeGreaterThan(initialRenderedCharacters);
    expect(view.queryByText("Entry 2999")).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy full content" }));
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text);
  });
});
