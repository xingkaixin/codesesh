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
  const sourceText = 'let newline = UInt8(ascii: "\\n")\nlet value = 1';

  it.each(["deepchat", "claudecode"])(
    "preserves literal escapes in decoded %s read output",
    (agentName) => {
      const tool = part({
        tool: "Read",
        state: { status: "completed", output: sourceText },
      });
      const strategy = getToolDisplayStrategy(agentName, tool, normalizeToolState(tool));

      expect(strategy.outputContent).toMatchObject({ kind: "plain", text: sourceText });
    },
  );

  it("decodes the Cursor JSON envelope without unescaping its file contents again", () => {
    const tool = part({
      tool: "read_file_v2",
      state: { status: "completed", output: JSON.stringify({ contents: sourceText }) },
    });
    const strategy = getToolDisplayStrategy("cursor", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: sourceText });
  });

  it("preserves literal escapes in written file contents", () => {
    const tool = part({
      tool: "Write",
      state: { status: "completed", input: { content: sourceText }, output: "File written" },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: sourceText });
  });

  it("keeps literal escapes on their original lines in an edit diff", () => {
    const tool = part({
      tool: "Edit",
      state: {
        status: "completed",
        input: { old_string: "let value = 0", new_string: sourceText },
      },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toMatchObject({
      kind: "structured-diff",
      blocks: [
        {
          lines: [
            { type: "remove", text: "let value = 0" },
            { type: "add", text: 'let newline = UInt8(ascii: "\\n")' },
            { type: "add", text: "let value = 1" },
          ],
        },
      ],
    });
  });

  it("preserves literal escapes in Codex patch contents", () => {
    const tool = part({
      tool: "patch",
      title: "patch",
      state: {
        status: "completed",
        input: [{ type: "write_file", path: "example.swift", content: sourceText }],
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toMatchObject({
      kind: "file-sections",
      sections: [{ text: sourceText }],
    });
  });

  it("preserves literal escapes after removing the Codex shell envelope", () => {
    const tool = part({
      tool: "bash",
      title: "bash",
      state: {
        status: "completed",
        input: { cmd: "cat example.swift" },
        output: [
          "Chunk ID: example",
          "Wall time: 0.1 seconds",
          "Process exited with code 0",
          "Original token count: 10",
          "Output:",
          sourceText,
        ].join("\n"),
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toMatchObject({ kind: "plain", text: sourceText });
  });

  it.each(["claudecode", "zcode"])(
    "shows the failed %s edit result instead of the proposed diff",
    (agentName) => {
      const error = "String to replace not found in file.";
      const tool = part({
        tool: "Edit",
        title: "Edit",
        state: {
          status: "error",
          input: { file_path: "/repo/example.ts", old_string: "old", new_string: "new" },
          ...(agentName === "claudecode" ? { output: [{ type: "text", text: error }] } : { error }),
        },
      });
      const strategy = getToolDisplayStrategy(agentName, tool, normalizeToolState(tool));

      expect(strategy.outputContent).toEqual({
        kind: "plain",
        text: error,
        language: "text",
        isCode: false,
      });
    },
  );

  it("shows the Codex patch failure instead of file operations from its input", () => {
    const error = "apply_patch verification failed: invalid patch";
    const tool = part({
      tool: "patch",
      title: "patch",
      state: {
        status: "error",
        input: [
          { type: "delete_file", path: "example.ts" },
          { type: "write_file", path: "example.ts", content: "new" },
        ],
        output: [{ type: "text", text: error }],
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toEqual({
      kind: "plain",
      text: error,
      language: "text",
      isCode: false,
    });
  });

  it("keeps the failed ZCode read error visible when no output was captured", () => {
    const error = "File does not exist.";
    const tool = part({
      tool: "Read",
      state: {
        status: "error",
        input: { file_path: "/repo/missing.ts" },
        error,
      },
    });
    const strategy = getToolDisplayStrategy("zcode", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toEqual({
      kind: "plain",
      text: error,
      language: "text",
      isCode: false,
    });
  });

  it.each(["send_message", "followup_task"])(
    "shows the complete message for Codex agents.%s",
    (operation) => {
      const message = "Inspect the parser.\nKeep the source data unchanged.";
      const tool = part({
        tool: "agents." + operation,
        title: "agents." + operation,
        state: { status: "completed", input: { target: "parser", message } },
      });
      const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

      expect(strategy.outputContent).toEqual({
        kind: "property-list",
        items: [
          { label: "Recipient", value: "parser" },
          { label: "Message", value: message },
        ],
      });
    },
  );

  it("shows the Codex agents.wait_agent timeout and captured updates", () => {
    const tool = part({
      tool: "agents.wait_agent",
      title: "agents.wait_agent",
      state: {
        status: "completed",
        input: { timeout_ms: 60000 },
        output: { timed_out: false },
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.secondaryText).toBe("60s timeout");
    expect(strategy.outputContent).toEqual({
      kind: "property-list",
      items: [{ label: "timed_out", value: false }],
    });
  });

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
  it.each([0, 1])("keeps Grok terminal bytes and its explicit exit code %i", (exitCode) => {
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
          exit_code: exitCode,
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
        { label: "Exit code", value: String(exitCode) },
      ],
      showInputPreview: false,
      contentLabel: exitCode === 0 ? "Terminal output" : "Error",
      outputContent: { kind: "plain", text: "passed\n", language: "text", isCode: false },
    });
  });
});
