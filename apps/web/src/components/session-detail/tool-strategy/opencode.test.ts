import { describe, expect, it } from "vitest";
import type { ToolPart } from "../../../lib/api";
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

  it("retains generic output for plugin tools", () => {
    expect(
      display({
        type: "tool",
        tool: "custom_plugin",
        state: {
          status: "completed",
          input: { query: "hello" },
          output: "Plugin result",
        },
      }),
    ).toMatchObject({
      title: "custom_plugin",
      outputContent: { kind: "plain", text: "Plugin result" },
    });
  });
});
