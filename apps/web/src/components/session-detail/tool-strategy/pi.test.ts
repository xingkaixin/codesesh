import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(tool: string, state: ToolPart["state"]) {
  const part: ToolPart = { type: "tool", tool, state };
  return getToolDisplayStrategy("pi", part, normalizeToolState(part), "/repo");
}

describe("Pi tool execution evidence", () => {
  it("shows Write.contents as the written file instead of its receipt", () => {
    expect(
      display("Write", {
        status: "completed",
        input: { path: "/repo/task.yaml", contents: "next_number: 281" },
        output: [{ type: "text", text: "Successfully wrote 16 bytes to /repo/task.yaml" }],
      }),
    ).toMatchObject({
      secondaryText: "task.yaml",
      outputContent: { kind: "plain", text: "next_number: 281", language: "yaml" },
    });
  });

  it.each([
    { background: false, status: "completed", output: "Agent completed in 26.6s\nReport saved." },
    {
      background: true,
      status: "background",
      output: "Agent started in background.\nAgent ID: task-a",
    },
  ])("retains the task and actual $status Agent result", ({ background, status, output }) => {
    const prompt = "Review the parser.\nReport the confirmed failures.";
    const strategy = display("Agent", {
      status: "completed",
      input: {
        description: "Review parser",
        subagent_type: "Explore",
        prompt,
        run_in_background: background,
      },
      output: [{ type: "text", text: output }],
      metadata: { agentId: "task-a", status },
    });
    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: output });
    expect(strategy.details.map((detail) => detail.value)).toEqual(
      expect.arrayContaining([prompt, status, "task-a"]),
    );
    expect(strategy.secondaryText).toContain(status);
  });

  it.each([
    {
      tool: "Grep",
      input: { path: "/repo/src", pattern: "TODO", glob: "*.ts" },
      summary: "src · TODO",
    },
    {
      tool: "Glob",
      input: { target_directory: "/repo/src", glob_pattern: "*.ts" },
      summary: "src · *.ts",
    },
    { tool: "Glob", input: { path: "/repo/src", pattern: "*.ts" }, summary: "src · *.ts" },
    { tool: "Glob", input: { glob: "*.ts" }, summary: "*.ts" },
    { tool: "LS", input: { path: "/repo/src" }, summary: "src" },
  ])("shows the native $tool search parameters with the result", ({ tool, input, summary }) => {
    expect(
      display(tool, { status: "completed", input, output: [{ type: "text", text: "src/a.ts" }] }),
    ).toMatchObject({
      secondaryText: summary,
      showInputPreview: tool === "Grep",
      outputContent: { kind: "plain", text: "src/a.ts" },
    });
  });

  it.each(["edit", "StrReplace"])(
    "shows applied %s diffs and retains failed edit errors",
    (tool) => {
      const state: ToolPart["state"] = {
        status: "completed",
        input:
          tool === "edit"
            ? { path: "/repo/a.ts", edits: [{ oldText: "before", newText: "after" }] }
            : { path: "/repo/a.ts", old_string: "before", new_string: "after" },
        output: [{ type: "text", text: "Successfully replaced 1 block(s) in /repo/a.ts." }],
        metadata: { patch: "@@\n-before\n+after" },
      };
      expect(display(tool, state).outputContent).toMatchObject({ kind: "structured-diff" });
      const error = "Could not find the exact text in /repo/a.ts.";
      expect(
        display(tool, {
          ...state,
          status: "error",
          output: [{ type: "text", text: error }],
        }).outputContent,
      ).toMatchObject({ kind: "plain", text: error });
    },
  );

  it.each(["bash", "batch", "Shell"])("keeps %s execution and truncation evidence", (tool) => {
    const strategy = display(tool, {
      status: "error",
      input: { command: "rg TODO /repo/src", description: "Find TODOs" },
      output: [{ type: "text", text: "Partial output\nCommand exited with code 127" }],
      metadata: {
        exitCode: 127,
        cancelled: true,
        fullOutputPath: "/tmp/pi-bash-output.log",
        truncation: {
          content: "Partial output",
          truncated: true,
          truncatedBy: "bytes",
          outputLines: 489,
          totalLines: 794,
          outputBytes: 51098,
          totalBytes: 82254,
        },
      },
    });
    expect(strategy.secondaryText).toBe("Find TODOs (rg TODO ./src)");
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      text: "Partial output\nCommand exited with code 127",
    });
    expect(strategy.details.map((detail) => detail.value)).toEqual(
      expect.arrayContaining([
        "127",
        "Cancelled",
        "Truncated",
        "489 / 794",
        "51098 / 82254 bytes",
        "/tmp/pi-bash-output.log",
      ]),
    );
  });

  it("shows bashExecution truncation without inventing an exit code", () => {
    const strategy = display("bash", {
      status: "completed",
      input: { command: "printf example" },
      output: [{ type: "text", text: "example" }],
      metadata: { truncated: true, fullOutputPath: "/tmp/pi-bash-output.log" },
    });
    expect(strategy.details.map((detail) => detail.value)).toEqual([
      "Truncated",
      "/tmp/pi-bash-output.log",
    ]);
  });
});
