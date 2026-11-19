import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

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
