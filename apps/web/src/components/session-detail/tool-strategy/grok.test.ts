import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { normalizeToolState } from "../tool-normalize";
import { buildGrokToolStrategy } from "./grok";

function display(tool: string, state: ToolPart["state"]) {
  const part: ToolPart = { type: "tool", tool, state };
  const normalized = normalizeToolState(part);
  return buildGrokToolStrategy(part, normalized, "/repo");
}

describe("Grok result envelopes", () => {
  it("keeps a completed background launch distinct from its running task", () => {
    const result = {
      type: "BackgroundTaskStarted",
      task_id: "task-example",
      task_type: "bash",
      status: "running",
      pid: 1234,
      command: "pnpm test",
      summary: "Tests started in the background.",
      output_file: "/tmp/task-example.log",
      retrieval_hint: "Retrieve task-example to read its output.",
    };
    const strategy = display("run_terminal_command", {
      status: "completed",
      input: { command: "pnpm test", is_background: true },
      output: result,
    });

    expect(strategy.showInputPreview).toBe(true);
    expect(strategy.outputContent).toEqual({
      kind: "task-list",
      items: [
        {
          label: result.summary,
          status: "in_progress",
          detail: result.retrieval_hint,
        },
      ],
    });
    expect(strategy.details).toEqual(
      expect.arrayContaining([
        { label: "task_id", value: "task-example" },
        { label: "status", value: "running" },
        { label: "pid", value: "1234" },
        { label: "output_file", value: "/tmp/task-example.log" },
      ]),
    );
  });

  it.each([
    ["running", null],
    ["completed", 0],
    ["completed", 7],
  ])("opens a Result envelope with task status %s and exit code %s", (status, exitCode) => {
    const strategy = display("get_command_or_subagent_output", {
      status: "completed",
      input: { task_ids: ["task-example"], timeout_ms: 60000 },
      output: {
        type: "TaskOutput",
        Result: {
          task_id: "task-example",
          command: "pnpm test",
          status,
          exit_code: exitCode,
          output: "Test output\n",
          truncated: true,
          output_file: "/tmp/task-example.log",
          truncation_hint: "Read the output file for the remaining lines.",
          raw_output_bytes: 10000,
        },
      },
    });

    expect(strategy.showInputPreview).toBe(true);
    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: "Test output\n" });
    expect(strategy.details).toEqual(
      expect.arrayContaining([
        { label: "task_id", value: "task-example" },
        { label: "status", value: status },
        { label: "truncation_hint", value: "Read the output file for the remaining lines." },
        { label: "raw_output_bytes", value: "10000" },
      ]),
    );
    expect(strategy.details.some((detail) => detail.value === String(exitCode))).toBe(
      exitCode !== null,
    );
    expect(strategy.contentLabel === "Error").toBe(exitCode === 7);
  });

  it("shows discovered MCP tool content and decodes the OkayOutput JSON boundary", () => {
    const search = display("search_tool", {
      status: "completed",
      input: { query: "local project tools", limit: 5 },
      output: { type: "SearchTool", content: "Available local tools", result_count: 1 },
    });
    expect(search.showInputPreview).toBe(true);
    expect(search.secondaryText).toContain("local project tools");
    expect(search.outputContent).toMatchObject({ kind: "plain", text: "Available local tools" });
    expect(search.details).toContainEqual({ label: "result_count", value: "1" });

    const result = { current: "example", guide: "Line one\nLine two", literal: "a\\nb" };
    const use = display("use_tool", {
      status: "completed",
      input: { tool_name: "local.example", tool_input: { action: "read" } },
      output: {
        type: "Mcp",
        tool_name: "example",
        server_name: "local",
        output: { OkayOutput: JSON.stringify(result) },
      },
    });
    expect(use.showInputPreview).toBe(true);
    expect(use.outputContent).toEqual({
      kind: "property-list",
      items: Object.entries(result).map(([label, value]) => ({ label, value })),
    });
    expect(use.details).toContainEqual({ label: "server_name", value: "local" });
  });

  it.each([
    ["get_command_or_subagent_output", { type: "TaskOutput", Result: "unrecognized" }],
    ["use_tool", { type: "Mcp", output: { OtherOutput: "Keep this result" } }],
    ["search_tool", { type: "SearchTool", content: { custom: "Keep this result" } }],
  ])("retains unrecognized %s results", (tool, output) => {
    const strategy = display(tool, { status: "completed", output });
    expect(strategy.outputContent).toEqual({
      kind: "property-list",
      items: Object.entries(output).map(([label, value]) => ({ label, value })),
    });
  });
});

describe("Grok semantic tool results", () => {
  it("renders applied edits rather than the proposed replacement", () => {
    const strategy = display("search_replace", {
      status: "completed",
      input: { file_path: "/repo/src/a.ts", old_string: "requested", new_string: "proposed" },
      output: {
        type: "SearchReplace",
        EditsApplied: {
          absolute_path: "/repo/src/a.ts",
          edits: {
            details: [
              { old_string: "old value", new_string: "new value", old_line: 12, new_line: 12 },
              { old_string: "old value", new_string: "new value", old_line: 24, new_line: 24 },
            ],
          },
        },
      },
    });

    expect(strategy.showInputPreview).toBe(true);
    expect(strategy.secondaryText).toBe("src/a.ts");
    expect(strategy.outputContent).toMatchObject({
      kind: "structured-diff",
      blocks: [
        {
          lines: [
            { type: "remove", text: "old value" },
            { type: "add", text: "new value" },
          ],
        },
        {
          lines: [
            { type: "remove", text: "old value" },
            { type: "add", text: "new value" },
          ],
        },
      ],
    });
  });

  it.each(["search_replace", "write"])(
    "keeps failed %s results ahead of requested content",
    (tool) => {
      const error = { message: "Permission denied", error: "tool_execution_failed" };
      const strategy = display(tool, {
        status: "error",
        input: {
          file_path: "/repo/src/a.ts",
          old_string: "old value",
          new_string: "new value",
          content: "proposed file",
        },
        error,
      });

      expect(strategy.showInputPreview).toBe(true);
      expect(strategy.outputContent.kind).not.toBe("structured-diff");
      expect(JSON.stringify(strategy.outputContent)).toContain("Permission denied");
      expect(JSON.stringify(strategy.outputContent)).not.toContain("proposed file");
    },
  );

  it.each(["saved file\n", ""])("shows the saved write content %j", (content) => {
    const strategy = display("write", {
      status: "completed",
      input: { file_path: "/repo/src/a.ts", content: "requested content" },
      output: {
        type: "Write",
        EditsApplied: { absolute_path: "/repo/src/a.ts", new_string: content },
      },
    });
    expect(strategy.showInputPreview).toBe(true);
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      text: content || "File is empty.",
      isCode: content.length > 0,
    });
  });

  it("decodes grep UTF-8 streams without interpreting no matches as a failure", () => {
    const stdout = "<workspace_result>没有匹配</workspace_result>\n";
    const stderr = "Search warning\n";
    const strategy = display("grep", {
      status: "completed",
      input: { path: "/repo/src", pattern: "missing", head_limit: 20 },
      output: {
        type: "GrepSearch",
        stdout: Array.from(new TextEncoder().encode(stdout)),
        stderr: Array.from(new TextEncoder().encode(stderr)),
        exit_code: 1,
        match_count: 0,
        file_matches: [],
      },
    });

    expect(strategy.showInputPreview).toBe(true);
    expect(strategy.secondaryText).toBe("src · missing");
    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: stdout });
    expect(strategy.details).toContainEqual({ label: "exit_code", value: "1" });
    expect(strategy.details).toContainEqual({ label: "match_count", value: "0" });
    expect(strategy.details).toContainEqual({ label: "stderr", value: stderr });
    expect(strategy.contentLabel).not.toBe("Error");
  });

  it("shows structured grep matches with their paths and line numbers", () => {
    const strategy = display("grep", {
      status: "completed",
      input: { path: "/repo/src", pattern: "value" },
      output: {
        type: "GrepSearch",
        stdout: [],
        stderr: [],
        exit_code: 0,
        match_count: 1,
        file_matches: [{ path: "/repo/src/a.ts", matches: [{ line_number: 4, content: "value" }] }],
        truncated: true,
      },
    });
    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: "src/a.ts:4: value" });
    expect(strategy.details).toContainEqual({ label: "truncated", value: "true" });
  });

  it("opens directory content and uses the returned todo state after a merge", () => {
    const list = display("list_dir", {
      status: "completed",
      input: { target_directory: "src" },
      output: {
        type: "ListDir",
        Content: { absolute_root_path: "/repo/src", content: "a.ts\nb.ts" },
      },
    });
    expect(list.showInputPreview).toBe(true);
    expect(list.secondaryText).toBe("src");
    expect(list.outputContent).toMatchObject({ kind: "plain", text: "a.ts\nb.ts" });

    const todos = display("todo_write", {
      status: "completed",
      input: { merge: true, todos: [{ id: "edit", status: "completed" }] },
      output: {
        type: "Todo",
        TodosUpdated: {
          todos: [
            { content: "Edit file", status: "completed", priority: "high" },
            { content: "Review file", status: "in_progress", priority: "medium" },
            { content: "Commit", status: "pending", priority: "low" },
          ],
        },
      },
    });
    expect(todos.showInputPreview).toBe(true);
    expect(todos.outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Edit file", status: "completed", detail: "high" },
        { label: "Review file", status: "in_progress", detail: "medium" },
        { label: "Commit", status: "pending", detail: "low" },
      ],
    });
  });
});
