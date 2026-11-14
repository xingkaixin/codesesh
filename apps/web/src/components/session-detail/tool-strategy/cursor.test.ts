import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(tool: ToolPart) {
  return getToolDisplayStrategy("cursor", tool, normalizeToolState(tool), "/repo");
}

describe("Cursor tool context", () => {
  it.each(["read", "read_file_v2"])(
    "shows known line counts without inventing %s content",
    (tool) => {
      expect(
        display({
          type: "tool",
          tool,
          state: {
            status: "completed",
            input: { targetFile: "/repo/src/example.ts", charsLimit: 10000 },
            output: { totalLinesInFile: 166 },
          },
        }),
      ).toMatchObject({
        title: "read",
        secondaryText: "src/example.ts",
        showInputPreview: true,
        details: [{ label: "Lines", value: "166" }],
        outputContent: { kind: "plain", text: "No output captured.", isCode: false },
      });
    },
  );

  it.each(["edit", "edit_file_v2"])("preserves %s receipts and the original input", (tool) => {
    expect(
      display({
        type: "tool",
        tool,
        state: {
          status: "completed",
          input: {
            relativeWorkspacePath: "src/example.ts",
            noCodeblock: true,
            cloudAgentEdit: false,
          },
          output: { beforeContentId: "before", afterContentId: "after" },
        },
      }),
    ).toMatchObject({
      title: "edit",
      secondaryText: "src/example.ts",
      showInputPreview: true,
      outputContent: {
        kind: "property-list",
        items: [
          { label: "beforeContentId", value: "before" },
          { label: "afterContentId", value: "after" },
        ],
      },
    });
  });

  it.each(["glob", "glob_file_search"])("renders %s paths with the search context", (tool) => {
    expect(
      display({
        type: "tool",
        tool,
        state: {
          status: "completed",
          input: { targetDirectory: "/repo/src", globPattern: "**/*.ts" },
          output: { directories: [{ absPath: "/repo/src", files: [{ relPath: "example.ts" }] }] },
        },
      }),
    ).toMatchObject({
      title: "glob",
      secondaryText: "src · **/*.ts",
      showInputPreview: true,
      outputContent: { kind: "plain", text: "/repo/src\n  example.ts", isCode: false },
    });
  });

  it.each(["grep", "ripgrep_raw_search"])(
    "keeps a %s request distinct from missing results",
    (tool) => {
      expect(
        display({
          type: "tool",
          tool,
          state: {
            status: "completed",
            input: { path: "/repo/src", pattern: "needle", caseInsensitive: true },
          },
        }),
      ).toMatchObject({
        title: "grep",
        secondaryText: "src · needle",
        showInputPreview: true,
        outputContent: { kind: "plain", text: "No output captured.", isCode: false },
      });
    },
  );

  it.each(["bash", "run_terminal_command_v2"])("keeps %s commands and receipts visible", (tool) => {
    const strategy = display({
      type: "tool",
      tool,
      state: {
        status: "completed",
        input: { command: "pwd", commandDescription: "Check directory", cwd: "/repo" },
        output: { output: "/repo", rejected: false, notInterrupted: true },
      },
    });
    expect(strategy).toMatchObject({
      title: "bash",
      secondaryText: "Check directory (pwd)",
      showInputPreview: true,
      outputContent: { kind: "plain", isCode: false },
    });
    if (strategy.outputContent.kind !== "plain") throw new Error("Expected terminal output");
    expect(JSON.parse(strategy.outputContent.text)).toEqual({
      output: "/repo",
      rejected: false,
      notInterrupted: true,
    });
  });

  it("keeps read errors visible as errors rather than file content", () => {
    const error = { contents: "File not found", totalLinesInFile: 0 };
    expect(
      display({
        type: "tool",
        tool: "read",
        state: {
          status: "error",
          input: { targetFile: "/repo/missing.ts" },
          output: error,
          error,
        },
      }),
    ).toMatchObject({
      showInputPreview: true,
      outputContent: {
        kind: "property-list",
        items: expect.arrayContaining([{ label: "contents", value: "File not found" }]),
      },
    });
  });

  it("labels streaming edits as requests and preserves pending or failed input", () => {
    const input = { relativeWorkspacePath: "src/example.ts", streamingContent: "-old\n+new" };
    expect(
      display({ type: "tool", tool: "edit", state: { status: "completed", input } }),
    ).toMatchObject({
      contentLabel: "Request",
      outputContent: { kind: "plain", text: "-old\n+new", language: "diff" },
    });
    expect(
      display({ type: "tool", tool: "edit", state: { status: "running", input } }),
    ).toMatchObject({
      showInputPreview: true,
      contentLabel: "Request",
      outputContent: { kind: "plain", text: "-old\n+new", language: "diff" },
    });
    expect(
      display({ type: "tool", tool: "edit", state: { status: "error", input, error: "Denied" } }),
    ).toMatchObject({
      showInputPreview: true,
      outputContent: { kind: "plain", text: "Denied", isCode: false },
    });
  });
});
