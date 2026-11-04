import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolOutputRenderer } from "./ToolOutputRenderer";
import type { ToolOutputContent } from "./types";

afterEach(cleanup);

function renderOutput(outputContent: ToolOutputContent) {
  return render(<ToolOutputRenderer outputContent={outputContent} />);
}

describe("ToolOutputRenderer", () => {
  it("renders structured diff blocks with line prefixes", () => {
    const view = renderOutput({
      kind: "structured-diff",
      blocks: [
        {
          label: "src/example.ts",
          lines: [
            { type: "context", text: "unchanged" },
            { type: "remove", text: "old value" },
            { type: "add", text: "new value" },
          ],
        },
      ],
    });

    expect(view.getByText("src/example.ts")).toBeTruthy();
    expect(view.getByText("-old value")).toBeTruthy();
    expect(view.getByText("+new value")).toBeTruthy();
  });
});
