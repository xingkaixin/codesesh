import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(tool: ToolPart) {
  return getToolDisplayStrategy("opencode", tool, normalizeToolState(tool), "/repo");
}

describe("OpenCode V2 tool display", () => {
  it("shows shell commands and output through the existing terminal strategy", () => {
    expect(
      display({
        type: "tool",
        tool: "shell",
        state: {
          status: "completed",
          input: { command: "pnpm test" },
          output: "Passed",
        },
      }),
    ).toMatchObject({
      title: "shell",
      outputContent: { kind: "plain", text: "Passed", language: "text" },
      secondaryText: "(pnpm test)",
      showInputPreview: false,
    });
  });

  it("renders V2 edit diffs while preserving failures and V1 metadata diffs", () => {
    const tool: ToolPart = {
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: { path: "/repo/a.ts", oldString: "before", newString: "after" },
        output: "Edited",
      },
    };
    expect(display(tool)).toMatchObject({
      secondaryText: "a.ts",
      outputContent: {
        kind: "structured-diff",
        blocks: [
          {
            label: "a.ts",
            lines: [
              { type: "remove", text: "before" },
              { type: "add", text: "after" },
            ],
          },
        ],
      },
    });
    expect(
      display({
        ...tool,
        state: { ...tool.state, status: "error", output: undefined, error: "Denied" },
      }).outputContent,
    ).toMatchObject({ kind: "plain", text: "Denied" });
    expect(
      display({
        ...tool,
        state: { ...tool.state, status: "error", output: "Partial output", error: "Denied" },
      }).outputContent,
    ).toMatchObject({ kind: "plain", text: "Denied\n\nPartial output" });
    expect(
      display({
        ...tool,
        state: {
          status: "completed",
          input: { filePath: "/repo/a.ts" },
          metadata: { diff: "@@\n-old\n+new" },
        },
      }).outputContent,
    ).toMatchObject({ kind: "plain", text: "@@\n-old\n+new", language: "diff" });
  });

  it("pairs metadata answers by question index without filling or shifting missing answers", () => {
    const questions = ["Project?", "Delivery?", "Location?", "Certification?"].map((question) => ({
      header: question,
      question,
      options: [{ label: "Option", description: "An option" }],
      multiple: true,
    }));
    const tool: ToolPart = {
      type: "tool",
      tool: "question",
      state: {
        status: "completed",
        input: { questions },
        output: "[Old tool result content cleared]",
        metadata: { answers: [["Project A"], [], ["Option", "Free text"]] },
      },
    };
    const content = display(tool).outputContent;
    expect(content.kind).toBe("question-list");
    if (content.kind !== "question-list") throw new Error("Expected questions");
    expect(content.questions.map(({ question, answers }) => ({ question, answers }))).toEqual([
      { question: "Project?", answers: ["Project A"] },
      { question: "Delivery?", answers: [] },
      { question: "Location?", answers: ["Option", "Free text"] },
      { question: "Certification?", answers: [] },
    ]);
    expect(content.questions[2]?.options).toEqual([{ label: "Option", description: "An option" }]);
    expect(content.questions[3]?.unansweredLabel).toBeTruthy();
    expect(
      display({ ...tool, state: { ...tool.state, metadata: {} } }).outputContent,
    ).toMatchObject({
      kind: "question-list",
      questions: questions.map(() => ({ answers: [] })),
    });
  });

  it("uses recorded todo states and priorities while leaving unknown states in the raw view", () => {
    const tool: ToolPart = {
      type: "tool",
      tool: "todowrite",
      state: {
        status: "completed",
        input: { todos: [{ content: "Inspect parser", status: "pending", priority: "high" }] },
        metadata: {
          todos: [
            { content: "Inspect parser", status: "completed", priority: "high" },
            { content: "Verify result", status: "in_progress", priority: "medium" },
            { content: "Publish change", status: "pending", priority: "low" },
          ],
        },
      },
    };
    expect(display(tool).outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Inspect parser", status: "completed", detail: "high" },
        { label: "Verify result", status: "in_progress", detail: "medium" },
        { label: "Publish change", status: "pending", detail: "low" },
      ],
    });
    expect(
      display({ ...tool, state: { ...tool.state, metadata: {} } }).outputContent,
    ).toMatchObject({
      kind: "task-list",
      items: [{ label: "Inspect parser", status: "pending" }],
    });
    expect(
      display({
        ...tool,
        state: {
          ...tool.state,
          metadata: { todos: [{ content: "Inspect parser", status: "unrecognized" }] },
        },
      }).outputContent.kind,
    ).not.toBe("task-list");
  });

  it("retains the full task prompt and result in the delegated task view", () => {
    const prompt = `Inspect the parser.\n${"Preserve the source evidence. ".repeat(100)}`;
    const output = `Findings:\n${"The parsed result is correct. ".repeat(100).trimEnd()}`;
    const strategy = display({
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: {
          description: "Review parser",
          subagent_type: "explore",
          command: "review",
          prompt,
        },
        output,
        metadata: { sessionId: "child-session" },
      },
    });
    expect(strategy.secondaryText).toContain("Review parser");
    expect(strategy.secondaryText).toContain("explore");
    expect(strategy.details.map(({ value }) => value)).toEqual(["child-session", "review", prompt]);
    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: output });
  });

  it("shows the fetch URL and format without discarding content or errors", () => {
    const tool: ToolPart = {
      type: "tool",
      tool: "webfetch",
      state: {
        status: "completed",
        input: { url: "https://example.com/docs", format: "text" },
        output: "Documentation content",
      },
    };
    expect(display(tool)).toMatchObject({
      secondaryText: "https://example.com/docs",
      details: [{ value: "text" }],
      outputContent: { kind: "plain", text: "Documentation content", language: "text" },
    });
    expect(
      display({
        ...tool,
        state: {
          ...tool.state,
          status: "error",
          output: undefined,
          error: "Request failed: 404",
        },
      }).outputContent,
    ).toMatchObject({ kind: "plain", text: "Request failed: 404" });
  });

  it("keeps explicit invalid errors visible alongside a cleared result", () => {
    const error = "Invalid input for tool edit: JSON parsing failed";
    const strategy = display({
      type: "tool",
      tool: "invalid",
      state: {
        status: "error",
        input: { tool: "edit", error },
        error,
        output: "[Old tool result content cleared]",
      },
    });
    expect(strategy.secondaryText).toBe("edit");
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      text: `${error}\n\n[Old tool result content cleared]`,
    });
  });

  it("shows source truncation, output references and exits on affected tool views", () => {
    for (const tool of ["bash", "shell", "read", "grep", "glob"]) {
      const part: ToolPart = {
        type: "tool",
        tool,
        state: {
          status: "completed",
          input: { command: "inspect", filePath: "/repo/a.ts", pattern: "word" },
          output: "Partial output",
          metadata: { truncated: true },
        },
      };
      const truncated = display(part);
      expect(truncated.details).toHaveLength(1);
      expect(truncated.outputContent).toMatchObject({ kind: "plain", text: "Partial output" });
      expect(display({ ...part, state: { ...part.state, metadata: {} } }).details).toEqual([]);
      expect(
        display({ ...part, state: { ...part.state, metadata: { truncated: false } } }).details,
      ).toEqual([]);
      const withContext = display({
        ...part,
        state: {
          ...part.state,
          metadata: { truncated: true, exit: 0, outputPath: "/source/tool-output/log.txt" },
        },
      });
      expect(withContext.details.map(({ value }) => value)).toContain("0");
      expect(withContext.details.map(({ value }) => value)).toContain(
        "/source/tool-output/log.txt",
      );
      expect(withContext.outputContent).toMatchObject({ kind: "plain", text: "Partial output" });
      const failed = display({
        ...part,
        state: {
          ...part.state,
          status: "error",
          error: "Command failed",
          metadata: { truncated: true, exit: 2 },
        },
      });
      expect(failed.details.map(({ value }) => value)).toContain("2");
      expect(failed.details).toHaveLength(2);
      expect(failed.outputContent).toMatchObject({
        kind: "plain",
        text: "Command failed\n\nPartial output",
      });
    }
  });
});
