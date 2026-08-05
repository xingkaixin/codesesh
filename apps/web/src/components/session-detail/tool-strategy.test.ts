import { describe, expect, it } from "vitest";
import type { Message, ToolPart } from "../../lib/api";
import {
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./tool-strategy";

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

describe("normalizeToolState", () => {
  it("extracts input/output/error from tool state", () => {
    const state = normalizeToolState(
      part({
        state: { input: { file: "/a.ts" }, status: "completed", output: "content" },
      }),
    );
    expect(state.status).toBe("completed");
    expect(state.inputValue).toEqual({ file: "/a.ts" });
    expect(state.outputValue).toBe("content");
  });

  it("reads command from input", () => {
    const state = normalizeToolState(
      part({ state: { input: '{"cmd":"ls"}', status: "completed" } }),
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

  it("renders Grok image reads as media", () => {
    const tool = part({
      tool: "read_file",
      title: "read",
      state: {
        status: "completed",
        input: { target_file: "preview.png" },
        output: {
          type: "ReadFile",
          ImageContent: {
            data: "iVBORw0KGgo=",
            mime_type: "image/png",
          },
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "read",
      secondaryText: "preview.png",
      details: [{ label: "Format", value: "image/png" }],
      showInputPreview: false,
      outputContent: {
        kind: "media",
        items: [{ src: "data:image/png;base64,iVBORw0KGgo=", alt: "Tool output image 1" }],
      },
    });
  });

  it("does not render rejected Grok image data as text", () => {
    const tool = part({
      tool: "read_file",
      title: "read",
      state: {
        status: "completed",
        input: { target_file: "preview.bin" },
        output: {
          type: "ReadFile",
          ImageContent: {
            data: "not-an-image",
            mime_type: "application/octet-stream",
          },
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "read",
      secondaryText: "preview.bin",
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "Image preview unavailable.",
        language: "text",
        isCode: false,
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

  it("renders Grok web_fetch failures without raw JSON", () => {
    const tool = part({
      tool: "web_fetch",
      title: "web fetch",
      state: {
        status: "error",
        input: { variant: "WebFetch", url: "https://example.com/docs" },
        error: {
          error: "tool_execution_failed",
          message: "Request blocked by policy.",
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "web fetch",
      secondaryText: "https://example.com/docs",
      details: [{ label: "Type", value: "tool_execution_failed" }],
      showInputPreview: false,
      contentLabel: "Error",
      outputContent: {
        kind: "plain",
        text: "Request blocked by policy.",
        language: "markdown",
        isCode: false,
      },
    });
  });

  it("renders successful Grok web_fetch content", () => {
    const tool = part({
      tool: "web_fetch",
      title: "web fetch",
      state: {
        status: "completed",
        input: { url: "https://example.com/start" },
        output: {
          type: "WebFetch",
          Content: {
            url: "https://example.com/final",
            content: "# Example\n\nPage body",
            content_type: "markdown",
            status_code: 200,
            bytes: 20,
          },
        },
      },
    });
    const strategy = getToolDisplayStrategy("grok", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "web fetch",
      secondaryText: "https://example.com/final",
      details: [
        { label: "Status", value: "200" },
        { label: "Content type", value: "markdown" },
        { label: "Size", value: "20 bytes" },
      ],
      showInputPreview: false,
      contentLabel: "Page content",
      outputContent: {
        kind: "plain",
        text: "# Example\n\nPage body",
        language: "markdown",
        isCode: false,
      },
    });
  });

  it("renders Kimi-Code question answers from JSON output", () => {
    const tool = part({
      tool: "AskUserQuestion",
      title: "ask",
      state: {
        status: "completed",
        input: {
          questions: [
            {
              header: "响应式",
              question: "响应式回退方案怎么定？",
              options: [{ label: "浮层", description: "不挤压详情" }],
            },
          ],
        },
        output: JSON.stringify({ answers: { "响应式回退方案怎么定？": "浮层" } }),
      },
    });

    const strategy = getToolDisplayStrategy("kimi-code", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({ title: "ask", showInputPreview: false });
    expect(strategy.outputContent).toEqual({
      kind: "question-list",
      questions: [
        {
          header: "响应式",
          question: "响应式回退方案怎么定？",
          options: [{ label: "浮层", description: "不挤压详情" }],
          answers: ["浮层"],
        },
      ],
    });
  });

  it("renders Kimi-Code TodoList items instead of raw JSON", () => {
    const tool = part({
      tool: "TodoList",
      title: "todo",
      state: {
        status: "completed",
        input: {
          todos: [
            { title: "Inspect", status: "completed" },
            { title: "Patch", status: "pending" },
          ],
        },
        output: "Todo list updated.",
      },
    });

    const strategy = getToolDisplayStrategy("kimi-code", tool, normalizeToolState(tool));

    expect(strategy).toMatchObject({
      title: "todo",
      secondaryText: "1 completed · 1 pending",
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "- [x] Inspect\n- [ ] Patch",
        language: "markdown",
      },
    });
  });

  it("renders Codex update_plan as a checklist", () => {
    const tool = part({
      tool: "update_plan",
      title: "Tool: update_plan",
      state: {
        status: "completed",
        input: {
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
        input: { search_query: [{ q: "MLX audio" }, { q: "diarization" }] },
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
        input: { path: "/repo/shot.jpeg", detail: "original" },
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
        input: { target: "reviewer", message: "Please check the tool renderer." },
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
