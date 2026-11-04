import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./tool-strategy";

function part(overrides?: Partial<ToolPart>): ToolPart {
  return {
    type: "tool",
    tool: "Read",
    title: "Read",
    state: { status: "completed" },
    ...overrides,
  };
}

const FILE_TOOL_CASES = [
  ["claudecode", "Read", "read"],
  ["claudecode", "Edit", "edit"],
  ["claudecode", "Write", "write"],
  ["opencode", "Read", "read"],
  ["opencode", "Edit", "edit"],
  ["opencode", "Write", "write"],
  ["pi", "Read", "read"],
  ["pi", "Edit", "edit"],
  ["pi", "Write", "write"],
  ["zcode", "Read", "read"],
  ["zcode", "Edit", "edit"],
  ["zcode", "Write", "write"],
  ["kimi", "ReadFile", "read"],
  ["kimi", "StrReplaceFile", "edit"],
  ["kimi", "WriteFile", "write"],
  ["kimi-code", "ReadFile", "read"],
  ["kimi-code", "StrReplaceFile", "edit"],
  ["kimi-code", "WriteFile", "write"],
  ["kimi-code", "Read", "read"],
  ["kimi-code", "Edit", "edit"],
  ["kimi-code", "Write", "write"],
  ["cursor", "read_file_v2", "read"],
  ["cursor", "edit_file_v2", "edit"],
] as const;

describe("getToolDisplayStrategy", () => {
  it.each(FILE_TOOL_CASES)(
    "normalizes %s %s to the canonical %s file strategy",
    (agentName, toolName, title) => {
      const tool = part({
        tool: toolName,
        title: agentName === "zcode" ? "" : "Agent-specific title",
        state: {
          status: "completed",
          input: {
            file_path: "/repo/src/example.ts",
            old_string: "old",
            new_string: "new",
            streamingContent: "-old\n+new",
            content: "new",
          },
          output: agentName === "cursor" ? { contents: "const value = 1;" } : "updated",
        },
      });

      const strategy = getToolDisplayStrategy(agentName, tool, normalizeToolState(tool), "/repo");

      expect(strategy).toMatchObject({
        title,
        secondaryText: "src/example.ts",
        showInputPreview: false,
      });
      if (title !== "edit") {
        expect(strategy.outputContent).toMatchObject({
          kind: "plain",
          language: "typescript",
          isCode: true,
        });
      }
    },
  );

  it("renders ZCode edit metadata as a structured diff", () => {
    const tool = part({
      tool: "Edit",
      title: "",
      state: {
        status: "completed",
        input: {
          file_path: "/repo/src/a.ts",
          old_string: "old",
          new_string: "new",
        },
        output: "updated",
        metadata: {
          display: {
            filePath: "/repo/src/a.ts",
            additions: 1,
            deletions: 1,
            structuredPatch: [
              {
                lines: [" const a = 1", "-old", "+new"],
              },
            ],
          },
        },
      },
    });
    const strategy = getToolDisplayStrategy("zcode", tool, normalizeToolState(tool), "/repo");

    expect(strategy.title).toBe("edit");
    expect(strategy.secondaryText).toBe("src/a.ts");
    expect(strategy.details).toEqual([
      { label: "Additions", value: "1" },
      { label: "Deletions", value: "1" },
    ]);
    expect(strategy.outputContent).toEqual({
      kind: "structured-diff",
      blocks: [
        {
          label: "a.ts · /repo/src/a.ts",
          lines: [
            { type: "context", text: "const a = 1" },
            { type: "remove", text: "old" },
            { type: "add", text: "new" },
          ],
        },
      ],
    });
  });
  it("renders Grok read_file as file content", () => {
    const tool = part({
      tool: "read_file",
      title: "read",
      state: {
        status: "completed",
        input: { variant: "ReadFile", target_file: "src/example.ts", limit: 20 },
        output: {
          type: "ReadFile",
          FileContent: {
            content: "1→export const value = 1;",
            content_concise: "1→export const value = 1;",
            absolute_path: "/repo/src/example.ts",
            offset: 0,
            limit: 20,
            raw_output: "export const value = 1;\n",
            total_lines: 1,
          },
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool), "/repo");

    expect(strategy).toMatchObject({
      title: "read",
      secondaryText: "src/example.ts",
      details: [
        { label: "Lines", value: "1" },
        { label: "Offset", value: "0" },
        { label: "Limit", value: "20" },
      ],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "export const value = 1;\n",
        language: "typescript",
        isCode: true,
      },
    });
  });
  it("decodes Grok terminal bytes into terminal output", () => {
    const tool = part({
      tool: "run_terminal_command",
      title: "bash",
      state: {
        status: "completed",
        input: { command: "pnpm test", description: "Run tests" },
        output: {
          type: "Bash",
          output: [112, 97, 115, 115, 101, 100, 10],
          output_for_prompt: "exit: 0\npassed",
          exit_code: 0,
          command: "pnpm test",
          current_dir: "/repo",
          signal: null,
          timed_out: false,
          truncated: false,
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool), "/repo");

    expect(strategy).toMatchObject({
      title: "bash",
      secondaryText: "Run tests",
      details: [
        { label: "Command", value: "pnpm test" },
        { label: "Workdir", value: "." },
        { label: "Exit code", value: "0" },
      ],
      showInputPreview: false,
      contentLabel: "Terminal output",
      outputContent: { kind: "plain", text: "passed\n", language: "text", isCode: false },
    });
  });
});
