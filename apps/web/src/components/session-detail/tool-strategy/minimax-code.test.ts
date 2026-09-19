import { describe, expect, it } from "vitest";
import type { ToolPart } from "../../../lib/api";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(
  name: string,
  input: unknown,
  output?: unknown,
  metadata?: unknown,
  status: "completed" | "running" | "error" = "completed",
) {
  const tool: ToolPart = { type: "tool", tool: name, state: { status, input, output, metadata } };
  return getToolDisplayStrategy("minimax-code", tool, normalizeToolState(tool), "/repo");
}

describe("MiniMax tool display", () => {
  it("uses file, search and terminal displays for local tools", () => {
    expect(display("read", { path: "/repo/a.ts" }, { text: "const a = 1;" })).toMatchObject({
      title: "read",
      secondaryText: "a.ts",
      outputContent: { kind: "plain", text: "const a = 1;", language: "typescript" },
    });
    expect(display("write", { path: "/repo/a.ts", content: "new file" })).toMatchObject({
      title: "write",
      outputContent: { text: "new file" },
    });
    expect(
      display("grep", { path: "/repo/src", pattern: "pattern" }, { text: "a.ts" }).secondaryText,
    ).toContain("pattern");
    expect(display("glob", { pattern: "**/*.ts" }, { text: "a.ts" }).secondaryText).toContain(
      "**/*.ts",
    );
    expect(
      display("bash", { command: "pnpm test" }, { text: "OK" }, { task_id: "background-1" }),
    ).toMatchObject({
      title: "bash",
      outputContent: { text: "OK" },
      details: expect.arrayContaining([{ label: "Task ID", value: "background-1" }]),
    });
    expect(display("skill", { name: "review" }, { text: "Loaded" }).title).toBeTruthy();
  });

  it("renders both known edit shapes and preserves errors instead of a success diff", () => {
    const input = { file_path: "/repo/a.ts", old_string: "before", new_string: "after" };
    expect(display("edit", input).outputContent).toMatchObject({
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
    });
    expect(
      display("edit", { path: "/repo/a.ts", edits: [{ oldText: "before", newText: "after" }] })
        .outputContent.kind,
    ).toBe("structured-diff");
    expect(
      display("edit", input, { error: "File missing" }, undefined, "error").outputContent.kind,
    ).not.toBe("structured-diff");
  });

  it("shows todos, task handles, and unanswered questionnaire steps", () => {
    expect(
      display("todowrite", {
        todos: [
          { content: "Build", status: "completed" },
          { content: "Old task", status: "cancelled" },
        ],
      }).outputContent,
    ).toEqual({
      kind: "task-list",
      items: [
        { label: "Build", status: "completed", detail: undefined },
        { label: "Old task", status: "pending", detail: "cancelled" },
      ],
    });
    for (const name of ["task", "task_append", "task_query", "task_output", "task_stop"]) {
      expect(
        display(
          name,
          { task_id: "task-1", prompt: "Review" },
          { text: "Done" },
          { sub_session_id: "child" },
        ),
      ).toMatchObject({
        details: [
          { label: "Task ID", value: "task-1" },
          { label: "Session ID", value: "child" },
        ],
      });
    }
    const question = {
      title: "Target",
      steps: [
        {
          id: "choice",
          question: "Which target?",
          options: [{ label: "Local", recommended: true }, { label: "Remote" }],
        },
      ],
    };
    expect(
      display("ask_user", question, { text: "Waiting for user" }, { waiting_for_user: true })
        .outputContent,
    ).toMatchObject({
      kind: "question-list",
      questions: [
        {
          question: "Which target?",
          answers: [],
          options: [{ label: "Local", recommended: true }, { label: "Remote" }],
        },
      ],
    });
    expect(
      display("ask_user", question, { text: "Suppressed" }, { suppressed: true }).outputContent
        .kind,
    ).not.toBe("question-list");
  });

  it("retains MCP invocation arguments and generic plugin output", () => {
    expect(
      display(
        "mcp_invoke",
        { tool_name: "repo_search", arguments: { q: "test" } },
        { text: "Found" },
      ),
    ).toMatchObject({ title: "repo_search", secondaryText: "mcp_invoke", showInputPreview: true });
    expect(display("mcp_invoke", { tool_ref: "opaque-ref", arguments_json: "{}" }).title).toBe(
      "mcp_invoke",
    );
    const fallback = display("future_plugin", { payload: 1 }, { custom: "value" });
    expect(fallback).toMatchObject({ title: "future_plugin", showInputPreview: true });
    expect(JSON.stringify(fallback.outputContent)).toContain("value");
  });
});
