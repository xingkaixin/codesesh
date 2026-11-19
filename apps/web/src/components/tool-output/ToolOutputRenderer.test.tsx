import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolOutputRenderer } from "./ToolOutputRenderer";
import type { ToolOutputContent } from "./types";

afterEach(cleanup);

function renderOutput(outputContent: ToolOutputContent, highlightQuery?: string) {
  return render(
    <ToolOutputRenderer outputContent={outputContent} highlightQuery={highlightQuery} />,
  );
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

  it("highlights search queries across plain, code, unified diff, and structured diff outputs", () => {
    const plain = renderOutput(
      { kind: "plain", text: "stdout: retryToken accepted", language: "text", isCode: false },
      "retryToken",
    );
    expect(
      Array.from(plain.container.querySelectorAll("mark"), (node) => node.textContent),
    ).toEqual(["retryToken"]);
    plain.unmount();

    const code = renderOutput(
      { kind: "plain", text: "const retryToken = fetchToken();", language: "ts", isCode: true },
      "retryToken",
    );
    expect(Array.from(code.container.querySelectorAll("mark"), (node) => node.textContent)).toEqual(
      ["retryToken"],
    );
    code.unmount();

    const unified = renderOutput(
      {
        kind: "plain",
        text: "@@ -1 +1 @@\n+const retryToken = 1;",
        language: "diff",
        isCode: true,
      },
      "retryToken",
    );
    expect(
      Array.from(unified.container.querySelectorAll("mark"), (node) => node.textContent),
    ).toEqual(["retryToken"]);
    unified.unmount();

    const structured = renderOutput(
      {
        kind: "structured-diff",
        blocks: [
          {
            label: "src/retryToken.ts",
            lines: [{ type: "add", text: "export const retryToken = true;" }],
          },
        ],
      },
      "retryToken",
    );
    expect(
      Array.from(structured.container.querySelectorAll("mark"), (node) => node.textContent),
    ).toEqual(["retryToken", "retryToken"]);
  });
});
