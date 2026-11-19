import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownContent search highlighting", () => {
  it("highlights matches inside prose, inline code, and fenced code blocks", () => {
    const markdown = [
      "Check the `panicHandler` symbol before merging.",
      "",
      "```ts",
      "export function panicHandler(error: Error) {",
      '  throw new Error("panicHandler failed");',
      "}",
      "```",
    ].join("\n");

    const { container } = render(<MarkdownContent text={markdown} highlightQuery="panicHandler" />);

    const inlineMarks = container.querySelectorAll("p code mark");
    const fencedMarks = container.querySelectorAll("pre code mark");
    expect(Array.from(inlineMarks, (node) => node.textContent)).toEqual(["panicHandler"]);
    expect(Array.from(fencedMarks, (node) => node.textContent)).toEqual([
      "panicHandler",
      "panicHandler",
    ]);
    expect(container.querySelector("mark mark")).toBeNull();
  });
});

describe("MarkdownContent safe links", () => {
  it("renders http and https links as safe external anchors with a URL hint", () => {
    const markdown = [
      "See [the PR](https://github.com/org/repo/pull/42) and [local docs](http://localhost:8080/guide).",
    ].join("\n");

    const { getByRole } = render(<MarkdownContent text={markdown} />);

    const prLink = getByRole("link", { name: "the PR" });
    expect(prLink.getAttribute("href")).toBe("https://github.com/org/repo/pull/42");
    expect(prLink.getAttribute("target")).toBe("_blank");
    expect(prLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(prLink.getAttribute("title")).toBe("https://github.com/org/repo/pull/42");

    const localLink = getByRole("link", { name: "local docs" });
    expect(localLink.getAttribute("href")).toBe("http://localhost:8080/guide");
    expect(localLink.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("downgrades unsafe link protocols to plain spans while keeping remote images blocked", () => {
    const markdown = [
      "[xss](javascript:alert(1))",
      "[data](data:text/html,hi)",
      "[localfile](file:///etc/passwd)",
      "![tracker](https://tracker.example.com/pixel.png)",
    ].join("\n\n");

    const { container, queryByRole } = render(<MarkdownContent text={markdown} />);

    expect(queryByRole("link")).toBeNull();
    const downgraded = Array.from(
      container.querySelectorAll("span.console-markdown-link"),
      (node) => node.textContent,
    );
    expect(downgraded).toEqual(["xss", "data", "localfile"]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Remote image not loaded: tracker");
  });
});

describe("MarkdownContent fenced code blocks", () => {
  it("shows the language label and copies the raw code with feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const markdown = ["```rust", "fn main() {", '    println!("hello");', "}", "```"].join("\n");

    const { getByRole, getByText } = render(<MarkdownContent text={markdown} />);

    expect(getByText("rust")).toBeTruthy();

    const copyButton = getByRole("button", { name: "Copy code" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('fn main() {\n    println!("hello");\n}');
      expect(getByRole("button", { name: "Code copied" })).toBeTruthy();
    });
  });
});
