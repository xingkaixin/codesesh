import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSemanticOutputContent } from "../session-detail/tool-normalize";
import { ToolOutputRenderer } from "./ToolOutputRenderer";
import type { ToolOutputContent } from "./types";

afterEach(cleanup);

function renderOutput(outputContent: ToolOutputContent) {
  return render(<ToolOutputRenderer outputContent={outputContent} />);
}

describe("ToolOutputRenderer", () => {
  it("shows free text answers and recorded absence without selecting an option", () => {
    const view = renderOutput({
      kind: "question-list",
      questions: [
        { question: "Device?", options: [{ label: "Phone" }], answers: ["My own device"] },
        {
          question: "Environment?",
          options: [{ label: "Local" }],
          answers: [],
          unansweredLabel: "No answer recorded",
        },
      ],
    });
    expect(view.getByText("My own device")).toBeTruthy();
    expect(view.getByText("No answer recorded")).toBeTruthy();
    expect(view.queryByText("Selected")).toBeNull();
    expect(view.queryByRole("radio")).toBeNull();
  });

  it("renders conversation replies, defers activity and raw output, and reveals more turns", () => {
    const view = renderOutput({
      kind: "thread-read",
      title: "UI review",
      threadId: "thread-a",
      hasMore: true,
      newestFirst: true,
      request: [{ label: "threadId", value: "thread-a" }],
      rawOutput: "private raw result",
      turns: Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: `user-${index}`,
            content: [{ type: "text", text: `Question ${index}` }],
          },
          {
            type: "agentMessage",
            id: `agent-${index}`,
            phase: "final_answer",
            text: `**Reply ${index}**`,
          },
          {
            type: "commandExecution",
            id: `command-${index}`,
            command: "inspect",
            output: "deferred activity",
          },
        ],
      })),
    });
    expect(view.getByText("Reply 0").tagName).toBe("STRONG");
    expect(view.getByText("Question 0")).toBeTruthy();
    expect(view.queryByText("Question 5")).toBeNull();
    expect(view.queryByText("deferred activity")).toBeNull();
    expect(view.queryByText("private raw result")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show more turns" }));
    expect(view.getByText("Question 5")).toBeTruthy();
    expect(view.getByText("Earlier turns exist outside this tool result")).toBeTruthy();
    const raw = view.getByText("Raw output").closest("details")!;
    act(() => {
      raw.open = true;
      fireEvent(raw, new Event("toggle"));
    });
    expect(view.getByText("private raw result")).toBeTruthy();
    const activity = view.getAllByText("Other activity (1)")[0]!.closest("details")!;
    act(() => {
      activity.open = true;
      fireEvent(activity, new Event("toggle"));
    });
    const command = view.getByText("inspect").closest("details")!;
    act(() => {
      command.open = true;
      fireEvent(command, new Event("toggle"));
    });
    expect(view.container.textContent).toContain("deferred activity");
  });

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

  it("bounds large code and unified diff output before expensive rendering", () => {
    const codeText = `${"const value = 1;\n".repeat(3_000)}final_code_marker`;
    const code = renderOutput({
      kind: "plain",
      text: codeText,
      language: "typescript",
      isCode: true,
    });

    expect(code.container.textContent).not.toContain("final_code_marker");
    expect(code.getByRole("button", { name: "Render more content" })).toBeTruthy();
    code.unmount();

    const diffText = Array.from({ length: 5_000 }, (_, index) => `+changed line ${index}`).join(
      "\n",
    );
    const diff = renderOutput({
      kind: "plain",
      text: diffText,
      language: "diff",
      isCode: true,
    });

    expect(diff.queryByText("+changed line 4999")).toBeNull();
    expect(diff.container.querySelectorAll("pre > span").length).toBeLessThanOrEqual(800);
    expect(diff.getByRole("button", { name: "Render more content" })).toBeTruthy();
  });

  it("bounds structured diff lines and copies the complete diff", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const lines = Array.from({ length: 2_000 }, (_, index) => ({
      type: "add" as const,
      text: `changed line ${index}`,
    }));
    const view = renderOutput({
      kind: "structured-diff",
      blocks: [{ label: "src/large.ts", lines }],
    });

    expect(view.queryByText("+changed line 1999")).toBeNull();
    expect(view.container.querySelectorAll("pre > span").length).toBeLessThanOrEqual(799);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy full content" }));
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `diff src/large.ts\n${lines.map((line) => `+${line.text}`).join("\n")}`,
    );
  });
});

describe("Code execution output", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders ordered output while deferring source and copies the original source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { languages: ["en-US"], clipboard: { writeText } });
    const source = "  console.log('original');\nreturn 'done';\n";
    const view = renderOutput({
      kind: "code-execution",
      source,
      language: "typescript",
      failed: false,
      output: [
        { kind: "plain", text: "before", language: "text", isCode: false },
        { kind: "media", items: [{ src: "data:image/png;base64,eA==", alt: "middle" }] },
        { kind: "plain", text: "after", language: "text", isCode: false },
      ],
    });
    expect(
      [...view.container.querySelectorAll("pre,img")].map((el) =>
        el.tagName === "IMG" ? el.getAttribute("alt") : el.textContent,
      ),
    ).toEqual(["before", "middle", "after"]);
    expect(view.container.textContent).not.toContain("console.log");
    fireEvent.click(view.getByText("Source code · TypeScript"));
    expect(view.container.textContent).toContain("console.log");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy source" }));
    });
    expect(writeText).toHaveBeenCalledWith(source);
    vi.unstubAllGlobals();
  });

  it("opens source alongside an execution failure", () => {
    const view = renderOutput({
      kind: "code-execution",
      source: "invalid source",
      language: "javascript",
      failed: true,
      output: [{ kind: "plain", text: "SyntaxError", language: "text", isCode: false }],
    });
    expect(view.getByText("SyntaxError")).toBeTruthy();
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(view.container.textContent).toContain("invalid source");
  });
});
