import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import {
  formatMessageTime,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./tool-strategy";

function part(overrides?: Partial<MessagePart>): MessagePart {
  return { role: "tool", tool: "Read", title: "Read", state: {}, ...overrides } as MessagePart;
}

describe("normalizeToolState", () => {
  it("extracts input/output/error from tool state", () => {
    const state = normalizeToolState(
      part({
        state: { arguments: { file: "/a.ts" }, status: "completed", output: "content" },
      }),
    );
    expect(state.status).toBe("completed");
    expect(state.inputValue).toEqual({ file: "/a.ts" });
    expect(state.outputValue).toBe("content");
  });

  it("reads command from input", () => {
    const state = normalizeToolState(
      part({ state: { arguments: '{"cmd":"ls"}', status: "completed" } }),
    );
    expect(state.command).toBe("ls");
  });
});

describe("getToolDisplayStrategy", () => {
  it("routes to a per-agent builder", () => {
    const state = normalizeToolState(
      part({ tool: "read", title: "read", state: { status: "completed" } }),
    );
    const strategy = getToolDisplayStrategy(
      "claudecode",
      part({ tool: "read", title: "read" }),
      state,
    );
    expect(strategy).toBeDefined();
    expect(strategy.title).toBeTruthy();
  });

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

  it("renders ZCode questions as selectable question lists", () => {
    const tool = part({
      tool: "AskUserQuestion",
      title: "",
      state: {
        status: "completed",
        input: {
          questions: [
            {
              header: "模式",
              question: "选择模式?",
              options: [
                { label: "快速 (推荐)", description: "更快" },
                { label: "完整", description: "更细" },
              ],
            },
          ],
        },
        output: 'User has answered your questions: "选择模式?"="快速 (推荐)".',
      },
    });
    const strategy = getToolDisplayStrategy("zcode", tool, normalizeToolState(tool));

    expect(strategy.title).toBe("ask");
    expect(strategy.outputContent).toEqual({
      kind: "question-list",
      questions: [
        {
          header: "模式",
          question: "选择模式?",
          options: [
            { label: "快速", description: "更快", recommended: true },
            { label: "完整", description: "更细", recommended: undefined },
          ],
          answers: ["快速"],
        },
      ],
    });
  });

  it("renders ZCode todos from input instead of raw JSON output", () => {
    const tool = part({
      tool: "TodoWrite",
      title: "",
      state: {
        status: "completed",
        input: {
          todos: [
            { content: "Read files", status: "completed", priority: "high" },
            { content: "Patch UI", status: "in_progress", priority: "high" },
          ],
        },
        output: '{"todos":[]}',
      },
    });
    const strategy = getToolDisplayStrategy("zcode", tool, normalizeToolState(tool));

    expect(strategy.title).toBe("todo");
    expect(strategy.secondaryText).toBe("1 completed · 1 in_progress");
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      language: "markdown",
      text: "- [x] Read files _high_\n- [~] Patch UI _high_",
    });
  });

  it("cleans ZCode empty bash output", () => {
    const tool = part({
      tool: "Bash",
      title: "",
      state: {
        status: "completed",
        input: { command: "mkdir -p src", description: "Create directory" },
        output: "(Bash completed with no output)",
      },
    });
    const strategy = getToolDisplayStrategy("zcode", tool, normalizeToolState(tool));

    expect(strategy.title).toBe("bash");
    expect(strategy.secondaryText).toBe("Create directory (mkdir -p src)");
    expect(strategy.outputContent).toMatchObject({
      kind: "plain",
      text: "No output captured.",
    });
  });
});

describe("formatMessageTime", () => {
  it("formats a millisecond timestamp", () => {
    const result = formatMessageTime(Date.now());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getAssistantDisplayLabel", () => {
  it("returns USER for user role", () => {
    expect(getAssistantDisplayLabel({ role: "user" } as unknown as Message)).toBe("USER");
  });

  it("returns AGENT for assistant role", () => {
    expect(getAssistantDisplayLabel({ role: "assistant" } as unknown as Message)).toBe("AGENT");
  });
});

describe("normalizeMessagesForDisplay", () => {
  it("returns messages unchanged for non-cursor agents", () => {
    const messages = [{ role: "user", content: "hi" } as unknown as Message];
    expect(normalizeMessagesForDisplay(messages, "claudecode")).toBe(messages);
  });
});
