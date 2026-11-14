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
