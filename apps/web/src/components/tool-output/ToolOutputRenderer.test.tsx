import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildSemanticOutputContent } from "../session-detail/tool-normalize";
import { ToolOutputRenderer } from "./ToolOutputRenderer";
import type { ToolOutputContent } from "./types";

afterEach(cleanup);

function renderOutput(outputContent: ToolOutputContent) {
  return render(<ToolOutputRenderer outputContent={outputContent} />);
}

describe("ToolOutputRenderer", () => {
  it("renders plain, highlighted code, and unified diff output", () => {
    const plain = renderOutput({
      kind: "plain",
      text: "plain result",
      language: "text",
      isCode: false,
    });
    expect(plain.getByText("plain result")).toBeTruthy();
    plain.unmount();

    const code = renderOutput({
      kind: "plain",
      text: "const answer = 42;",
      language: "typescript",
      isCode: true,
    });
    expect(code.container.textContent).toContain("const answer = 42;");
    code.unmount();

    const diff = renderOutput({
      kind: "plain",
      text: "@@ -1 +1 @@\n-before\n+after",
      language: "diff",
      isCode: true,
    });
    expect(diff.getByText("@@ -1 +1 @@")).toBeTruthy();
    expect(diff.getByText("-before")).toBeTruthy();
    expect(diff.getByText("+after")).toBeTruthy();
  });

  it("uses a visible fallback when plain output is empty", () => {
    const view = renderOutput({ kind: "plain", text: "", language: "text", isCode: false });

    expect(view.getByText("No output captured.")).toBeTruthy();
  });

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

  it("renders file sections according to their content type", () => {
    const view = renderOutput({
      kind: "file-sections",
      sections: [
        {
          label: "notes.txt",
          operation: "write",
          language: "text",
          isCode: false,
          text: "release notes",
        },
        {
          label: "change.diff",
          operation: "edit",
          language: "diff",
          isCode: true,
          text: "+added line",
        },
        {
          label: "main.ts",
          operation: "edit",
          language: "typescript",
          isCode: true,
          text: "export const ready = true;",
        },
      ],
    });

    expect(view.getByText("notes.txt")).toBeTruthy();
    expect(view.getByText("release notes")).toBeTruthy();
    expect(view.getByText("+added line")).toBeTruthy();
    expect(view.container.textContent).toContain("export const ready = true;");
  });

  it("shows question state, recommendations, and selected answers", () => {
    const view = renderOutput({
      kind: "question-list",
      questions: [
        {
          header: "Runtime",
          question: "Which runtime should CI use?",
          options: [
            { label: "Node 24", description: "Current LTS", recommended: true },
            { label: "Node 22" },
          ],
          answers: ["Node 24"],
        },
        {
          question: "Deploy now?",
          options: [{ label: "Wait" }],
          answers: [],
        },
      ],
    });

    expect(view.getByText("Answered")).toBeTruthy();
    expect(view.getByText("Pending")).toBeTruthy();
    expect(view.getByText("Recommended")).toBeTruthy();
    expect(view.getByText("Selected")).toBeTruthy();
    expect(view.getByText("Current LTS")).toBeTruthy();
  });

  it("renders every task status and optional detail", () => {
    const view = renderOutput({
      kind: "task-list",
      items: [
        { label: "Queued task", status: "pending" },
        { label: "Active task", status: "in_progress", detail: "Running checks" },
        { label: "Finished task", status: "completed" },
        { label: "Broken task", status: "error" },
      ],
    });

    expect(view.getByText("Pending")).toBeTruthy();
    expect(view.getByText("In progress")).toBeTruthy();
    expect(view.getByText("Done")).toBeTruthy();
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByText("Running checks")).toBeTruthy();
  });

  it("renders semantic media output produced by normalization", () => {
    const outputContent = buildSemanticOutputContent([
      { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
      { type: "text", text: "Browser screenshot" },
    ]);
    if (!outputContent) throw new Error("Expected semantic media output");

    const view = renderOutput(outputContent);
    const image = view.getByRole("img", { name: "Tool output image 1" }) as HTMLImageElement;

    expect(image.src).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(view.getByText("Browser screenshot")).toBeTruthy();
  });

  it("renders semantic property output produced by normalization", () => {
    const outputContent = buildSemanticOutputContent({
      status: "complete",
      enabled: true,
      missing: null,
      metadata: { owner: "agent", tags: ["test", "coverage"] },
    });
    if (!outputContent) throw new Error("Expected semantic property output");

    const view = renderOutput(outputContent);

    expect(view.getByText("status")).toBeTruthy();
    expect(view.getByText("complete")).toBeTruthy();
    expect(view.getByText("Yes")).toBeTruthy();
    expect(view.getByText("—")).toBeTruthy();
    expect(view.getByText("owner")).toBeTruthy();
    expect(view.getByText("agent")).toBeTruthy();
    expect(view.getByText("coverage")).toBeTruthy();
  });
});
