import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import {
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

  it("renders Codex update_plan as a checklist", () => {
    const tool = part({
      tool: "update_plan",
      title: "Tool: update_plan",
      state: {
        status: "completed",
        arguments: {
          explanation: "halfway",
          plan: [
            { step: "Define seam", status: "completed" },
            { step: "Wire backend", status: "in_progress" },
            { step: "Update UI", status: "pending" },
          ],
        },
        output: [{ type: "text", text: "ok" }],
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.title).toBe("update plan");
    expect(strategy.secondaryText).toBe("halfway");
    expect(strategy.details).toEqual([
      { label: "completed", value: "1" },
      { label: "in_progress", value: "1" },
      { label: "pending", value: "1" },
    ]);
    expect(strategy.outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Define seam", status: "completed" },
        { label: "Wire backend", status: "in_progress" },
        { label: "Update UI", status: "pending" },
      ],
    });
  });

  it("renders Codex web__run search queries", () => {
    const tool = part({
      tool: "web__run",
      title: "Tool: web__run",
      state: {
        status: "completed",
        arguments: { search_query: [{ q: "MLX audio" }, { q: "diarization" }] },
        output: "results...",
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy.title).toBe("web search");
    expect(strategy.secondaryText).toBe("MLX audio · diarization");
  });

  it("renders Codex view_image with a relative path", () => {
    const tool = part({
      tool: "view_image",
      title: "Tool: view_image",
      state: {
        status: "completed",
        arguments: { path: "/repo/shot.jpeg", detail: "original" },
        output: "",
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool), "/repo");

    expect(strategy.title).toBe("view image");
    expect(strategy.secondaryText).toBe("shot.jpeg");
    expect(strategy.details).toEqual([
      { label: "Image", value: "shot.jpeg" },
      { label: "Detail", value: "original" },
    ]);
  });

  it("renders Claude tasks as status rows", () => {
    const tool = part({
      tool: "TodoWrite",
      state: {
        status: "completed",
        input: {
          todos: [
            { content: "Inspect formats", status: "completed" },
            { content: "Polish renderer", status: "in_progress", activeForm: "Rendering" },
          ],
        },
      },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "tasks",
      secondaryText: "1 completed · 1 in_progress",
      showInputPreview: false,
      contentLabel: "Task state",
    });
    expect(strategy.outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Inspect formats", status: "completed", detail: undefined },
        { label: "Polish renderer", status: "in_progress", detail: "Rendering" },
      ],
    });
  });

  it("renders Claude browser actions without raw input JSON", () => {
    const tool = part({
      tool: "mcp__claude-in-chrome__navigate",
      state: {
        status: "completed",
        input: { tabId: 42, url: "http://localhost:4173/session" },
        output: "Navigated",
      },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "browser · navigate",
      secondaryText: "http://localhost:4173/session",
      details: [{ label: "Tab", value: "42" }],
      showInputPreview: false,
      contentLabel: "Browser result",
    });
  });

  it("renders Claude structured submissions as fields", () => {
    const tool = part({
      tool: "StructuredOutput",
      state: {
        status: "completed",
        input: { verdict: "pass", findings: [{ severity: "low", title: "Spacing" }] },
        output: "Structured output submitted",
      },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy.outputContent).toEqual({
      kind: "property-list",
      items: [
        { label: "verdict", value: "pass" },
        { label: "findings", value: [{ severity: "low", title: "Spacing" }] },
      ],
    });
  });

  it("renders Claude messages without raw JSON", () => {
    const tool = part({
      tool: "SendMessage",
      state: {
        status: "completed",
        input: {
          to: "main",
          recipient: "main",
          summary: "Renderer findings",
          message: "The expanded tool card still shows JSON.",
          content: "The expanded tool card still shows JSON.",
        },
        output: [
          {
            type: "text",
            text: '{"success":true,"message":"Message queued for the main conversation."}',
          },
        ],
      },
    });
    const strategy = getToolDisplayStrategy("claudecode", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "send message",
      secondaryText: "main",
      showInputPreview: false,
      contentLabel: "Message details",
    });
    expect(strategy.outputContent).toEqual({
      kind: "property-list",
      items: [
        { label: "Recipient", value: "main" },
        { label: "Summary", value: "Renderer findings" },
        { label: "Message", value: "The expanded tool card still shows JSON." },
        { label: "Delivery", value: "Message queued for the main conversation." },
      ],
    });
  });

  it("renders Codex collaboration messages semantically", () => {
    const tool = part({
      tool: "collaboration.send_message",
      title: "Tool: collaboration.send_message",
      state: {
        status: "completed",
        arguments: { target: "reviewer", message: "Please check the tool renderer." },
        output: "Delivered",
      },
    });
    const strategy = getToolDisplayStrategy("codex", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "message agent",
      secondaryText: "reviewer",
      showInputPreview: false,
      contentLabel: "Message",
    });
    expect(strategy.outputContent).toEqual({
      kind: "property-list",
      items: [
        { label: "Recipient", value: "reviewer" },
        { label: "Message", value: "Please check the tool renderer." },
      ],
    });
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
