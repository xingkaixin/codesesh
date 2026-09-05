import { describe, expect, it } from "vitest";
import type { PlanPart, ToolPart } from "../../lib/api";
import { buildCodexPlanDisplay } from "./codex-plan";
import { getToolDisplayStrategy, normalizeToolState } from "./tool-strategy";
import {
  BookOpenText,
  Bot,
  CircleHelp,
  Clock3,
  FilePenLine,
  FileSearch,
  Image as ImageIcon,
  ListTodo,
  NotebookPen,
  Plug,
  SquareTerminal,
  Target,
  Users,
  Wrench,
} from "../ui/icons";

interface StrategyFixture {
  agent: string;
  tool: string;
  title?: string;
  status?: ToolPart["state"]["status"];
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: unknown;
  baseDirectory?: string;
}

function buildStrategy(fixture: StrategyFixture) {
  const tool: ToolPart = {
    type: "tool",
    tool: fixture.tool,
    title: fixture.title ?? fixture.tool,
    state: {
      status: fixture.status ?? "completed",
      input: fixture.input,
      output: fixture.output,
      error: fixture.error,
      metadata: fixture.metadata,
    },
  };

  return getToolDisplayStrategy(
    fixture.agent,
    tool,
    normalizeToolState(tool),
    fixture.baseDirectory ?? "/repo",
  );
}

describe("Pi tool strategy", () => {
  it("renders todo updates from the matching metadata task", () => {
    const strategy = buildStrategy({
      agent: "pi",
      tool: "Todo",
      input: { action: "update", id: 2 },
      metadata: {
        tasks: [
          { id: 1, subject: "Inspect", status: "completed" },
          {
            id: 2,
            subject: "Protect strategies",
            description: "Add output-level tests.",
            status: "completed",
          },
        ],
      },
      output: "Task updated (pending → completed)",
    });

    expect(strategy).toMatchObject({
      Icon: ListTodo,
      title: "todo update",
      secondaryText: "#2 · Protect strategies · pending -> completed",
      details: [
        { label: "ID", value: "#2" },
        { label: "Subject", value: "Protect strategies" },
        { label: "Status", value: "completed" },
        { label: "Change", value: "pending -> completed" },
      ],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "Add output-level tests.",
        language: "markdown",
        isCode: false,
      },
    });
  });

  it("renders a delegated agent request", () => {
    const strategy = buildStrategy({
      agent: "pi",
      tool: "Agent",
      input: {
        description: "Review rendering",
        subagent_type: "reviewer",
        prompt: "Check every tool card.",
      },
      metadata: { agentId: "agent-7", status: "running" },
    });

    expect(strategy).toMatchObject({
      Icon: Bot,
      title: "agent · reviewer",
      secondaryText: "#agent-7 · Review rendering",
      details: [
        { label: "Agent", value: "agent-7" },
        { label: "Type", value: "reviewer" },
        { label: "Status", value: "running" },
      ],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "Check every tool card.", language: "markdown" },
    });
  });

  it("summarizes a completed subagent result", () => {
    const strategy = buildStrategy({
      agent: "pi",
      tool: "get_subagent_result",
      input: { agent_id: "agent-7" },
      output: "Agent: reviewer\nStatus: completed · 3 findings\nAll cards verified.",
    });

    expect(strategy).toMatchObject({
      Icon: Bot,
      title: "subagent result",
      secondaryText: "#agent-7",
      details: [
        { label: "Agent", value: "reviewer" },
        { label: "Summary", value: "Status: completed · 3 findings" },
      ],
      showInputPreview: false,
    });
  });

  it("renders image analysis inputs and response", () => {
    const strategy = buildStrategy({
      agent: "pi",
      tool: "analyze_image",
      input: {
        images: ["/repo/screens/home.png", "/repo/screens/detail.png"],
        question: "Are the cards aligned?",
      },
      output: "The cards are aligned.",
    });

    expect(strategy).toMatchObject({
      Icon: ImageIcon,
      title: "analyze image",
      secondaryText: "screens/home.png, screens/detail.png",
      details: [
        { label: "Image", value: "screens/home.png" },
        { label: "Image 2", value: "screens/detail.png" },
        { label: "Question", value: "Are the cards aligned?" },
      ],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "The cards are aligned.", language: "markdown" },
    });
  });

  it.each([
    ["Bash", "bash"],
    ["Batch", "batch"],
  ])("renders %s commands as %s terminal output", (tool, title) => {
    const strategy = buildStrategy({
      agent: "pi",
      tool,
      input: { command: "node /repo/scripts/check.mjs" },
      output: "passed",
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title,
      secondaryText: "(node ./scripts/check.mjs)",
      showInputPreview: false,
      outputContent: { kind: "plain", text: "passed", language: "text", isCode: false },
    });
  });
});

describe("Cursor tool strategy", () => {
  it("renders ripgrep scope and pattern", () => {
    const strategy = buildStrategy({
      agent: "cursor",
      tool: "ripgrep_raw_search",
      input: { path: "/repo/src", pattern: "TODO" },
      output: "src/a.ts:4: TODO",
    });

    expect(strategy).toMatchObject({
      Icon: FileSearch,
      title: "grep",
      secondaryText: "src · TODO",
      details: [],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "src/a.ts:4: TODO", language: "text" },
    });
  });

  it("flattens Cursor glob directory results", () => {
    const strategy = buildStrategy({
      agent: "cursor",
      tool: "glob_file_search",
      input: { targetDirectory: "/repo/src", globPattern: "**/*.ts" },
      output: {
        directories: [
          {
            absPath: "/repo/src",
            files: [{ relPath: "a.ts" }, { absPath: "/repo/src/b.ts" }],
          },
        ],
      },
    });

    expect(strategy).toMatchObject({
      Icon: FileSearch,
      title: "glob",
      secondaryText: "src · **/*.ts",
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "/repo/src\n  a.ts\n  /repo/src/b.ts",
        language: "text",
      },
    });
  });

  it("renders terminal descriptions with workspace-relative commands", () => {
    const strategy = buildStrategy({
      agent: "cursor",
      tool: "run_terminal_command_v2",
      input: { command: "bash /repo/scripts/check.sh", commandDescription: "Run checks" },
      output: "ok",
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: "Run checks (bash ./scripts/check.sh)",
      showInputPreview: false,
      outputContent: { kind: "plain", text: "ok", language: "text", isCode: false },
    });
  });

  it("keeps line metadata when a read has no captured contents", () => {
    const strategy = buildStrategy({
      agent: "cursor",
      tool: "read_file_v2",
      input: { path: "/repo/src/a.ts" },
      output: '{"totalLinesInFile":"42"}',
    });

    expect(strategy).toMatchObject({
      title: "read",
      secondaryText: "src/a.ts",
      details: [{ label: "Lines", value: "42" }],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "No output captured.",
        language: "typescript",
        isCode: false,
      },
    });
  });
});

describe("Codex tool strategy", () => {
  it("renders a node repl browser result without its transport envelope", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "js",
      input: { title: "Inspect DOM" },
      metadata: { namespace: "mcp__node_repl__.js" },
      output: 'Result:\ncomplete\nOutput:\n[{"text":"button found"}]',
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "Browser",
      secondaryText: "Inspect DOM",
      details: [],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "button found", language: "text", isCode: false },
    });
  });

  it("classifies a readable exec command as source output", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "exec_command",
      input: {
        cmd: "nl -ba /repo/src/value.ts | sed -n '1,2p'",
        workdir: "/repo",
        sandbox_permissions: "require_escalated",
        justification: "Inspect generated source",
      },
      output: [
        "Chunk ID: abc123",
        "Wall time: 0.1 seconds",
        "Process exited with code 0",
        "Original token count: 4",
        "Output:",
        "",
        "  1\texport const value = 1;",
      ].join("\n"),
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: "Inspect generated source\nnl -ba ./src/value.ts | sed -n '1,2p'",
      details: [
        { label: "Command", value: "nl -ba ./src/value.ts | sed -n '1,2p'" },
        { label: "Workdir", value: "." },
        { label: "Escalation", value: "require_escalated" },
        { label: "Justification", value: "Inspect generated source" },
      ],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: "export const value = 1;",
        language: "typescript",
        isCode: true,
      },
    });
  });

  it("renders write_stdin session state and detects structured output", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "write_stdin",
      input: { session_id: 7, chars: "y\n" },
      output: '{"ok":true}',
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: "session #7 · stdin",
      details: [
        { label: "Session", value: "7" },
        { label: "Chars", value: "y\n" },
      ],
      outputContent: { kind: "plain", text: '{"ok":true}', language: "json", isCode: true },
    });
  });

  it("renders request_user_input questions and normalized answers", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "request_user_input",
      input: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which surface?",
            options: [
              { label: "Focused (Recommended)", description: "Only tool cards" },
              { label: "Everything" },
            ],
          },
        ],
      },
      output: JSON.stringify({ answers: { scope: { answers: ["Focused (Recommended)"] } } }),
    });

    expect(strategy).toMatchObject({
      Icon: CircleHelp,
      title: "ask",
      secondaryText: "1 questions · Scope",
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "question-list",
        questions: [
          {
            header: "Scope",
            question: "Which surface?",
            options: [
              { label: "Focused", description: "Only tool cards", recommended: true },
              { label: "Everything", description: undefined, recommended: undefined },
            ],
            answers: ["Focused"],
          },
        ],
      },
    });
  });

  it("renders every Codex patch operation as a file section", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "patch",
      input: {
        content: [
          { type: "write_file", path: "/repo/src/new.ts", content: "export {};\\n" },
          { type: "edit_file", path: "/repo/src/a.ts", content: "-old\\n+new" },
          { type: "delete_file", path: "/repo/src/dead.ts" },
          {
            type: "move_file",
            path: "/repo/src/old.ts",
            targetPath: "/repo/src/moved.ts",
          },
        ],
      },
      output: "Done!",
    });

    expect(strategy).toMatchObject({
      Icon: FilePenLine,
      title: "patch",
      secondaryText: "1 write · 1 edit · 1 delete · 1 move",
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "file-sections",
        sections: [
          {
            label: "src/new.ts",
            operation: "write",
            language: "typescript",
            isCode: true,
            text: "export {};\n",
          },
          {
            label: "src/a.ts",
            operation: "edit",
            language: "diff",
            isCode: true,
            text: "-old\n+new",
          },
          {
            label: "src/dead.ts",
            operation: "edit",
            language: "text",
            isCode: false,
            text: "File deleted.",
          },
          {
            label: "src/moved.ts",
            operation: "edit",
            language: "text",
            isCode: false,
            text: "Moved from src/old.ts to src/moved.ts",
          },
        ],
      },
    });
  });

  it("falls back to plain patch output when no operation is valid", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "patch",
      input: { content: [{ path: "/repo/src/a.ts" }] },
      output: "Patch rejected.",
    });

    expect(strategy).toMatchObject({
      Icon: FilePenLine,
      secondaryText: undefined,
      outputContent: {
        kind: "plain",
        text: "Patch rejected.",
        language: "text",
        isCode: false,
      },
    });
  });

  it("renders subagent execution parameters", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "subagent",
      input: {
        task_name: "reviewer",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        fork_turns: "all",
        service_tier: "priority",
      },
      output: "Review complete.",
    });

    expect(strategy).toMatchObject({
      Icon: Bot,
      title: "reviewer",
      secondaryText: undefined,
      details: [
        { label: "Model", value: "gpt-5.6-sol · Fast" },
        { label: "Effort", value: "high" },
        { label: "Fork", value: "all" },
      ],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "Review complete.", language: "markdown" },
    });
  });

  it.each([
    [
      "collaboration.wait_agent",
      { timeout_ms: 30_000 },
      Clock3,
      "wait for agents",
      "30s timeout",
      "Agent updates",
    ],
    ["collaboration.list_agents", {}, Users, "list agents", undefined, "Agent tree"],
    [
      "collaboration.interrupt_agent",
      { target: "reviewer" },
      Users,
      "interrupt agent",
      "reviewer",
      "Result",
    ],
  ])(
    "renders %s agent coordination state",
    (tool, input, Icon, title, secondaryText, contentLabel) => {
      const strategy = buildStrategy({ agent: "codex", tool, input, output: "ok" });

      expect(strategy).toMatchObject({
        Icon,
        title,
        secondaryText,
        details: [],
        showInputPreview: false,
        contentLabel,
      });
    },
  );

  it("renders goal state semantically", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "create_goal",
      input: { objective: "Finish characterization tests" },
      output: { status: "active" },
    });

    expect(strategy).toMatchObject({
      Icon: Target,
      title: "create goal",
      secondaryText: "Finish characterization tests",
      details: [],
      showInputPreview: false,
      contentLabel: "Goal state",
    });
  });

  it("renders namespaced integrations as semantic properties", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "airtable._search",
      input: { query: "tool strategy", limit: 5 },
      output: "",
    });

    expect(strategy).toMatchObject({
      Icon: Plug,
      title: "airtable · search",
      secondaryText: "tool strategy",
      details: [],
      showInputPreview: false,
      contentLabel: "Request",
      outputContent: {
        kind: "property-list",
        items: [
          { label: "query", value: "tool strategy" },
          { label: "limit", value: 5 },
        ],
      },
    });
  });

  it("renders skills without expanding raw input", () => {
    const strategy = buildStrategy({
      agent: "codex",
      tool: "skill",
      input: { name: "/repo/.agents/skills/review" },
      output: "loaded",
    });

    expect(strategy).toMatchObject({
      Icon: Wrench,
      title: "skill",
      secondaryText: "./.agents/skills/review",
      expandable: false,
      showInputPreview: false,
    });
  });
});

describe("DSH tool strategy", () => {
  it("renders bash with its description, command and working directory", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "bash",
      input: {
        command: "pwd && ls",
        description: "Show working directory and root files",
        workdir: "/repo/packages/core",
      },
      output: "packages",
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: "Show working directory and root files (pwd && ls)",
      details: [{ label: "Workdir", value: "packages/core" }],
      showInputPreview: false,
      outputContent: { kind: "plain", text: "packages", language: "text", isCode: false },
    });
  });

  it("renders read against the file the model asked for", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "read",
      input: { file_path: "/repo/README.md" },
      output: "1|# Title",
    });

    expect(strategy).toMatchObject({
      Icon: BookOpenText,
      title: "read",
      secondaryText: "README.md",
      outputContent: { kind: "plain", text: "# Title", language: "markdown" },
    });
  });

  it("renders write with the content it committed", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "write",
      input: { file_path: "/repo/src/index.ts", content: "export const x = 1;" },
      output: "wrote 1 line",
    });

    expect(strategy).toMatchObject({
      Icon: NotebookPen,
      title: "write",
      secondaryText: "src/index.ts",
      outputContent: { kind: "plain", text: "export const x = 1;", language: "typescript" },
    });
  });

  it("prefers the result-time hunks over the literal edit arguments", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "edit",
      input: { file_path: "/repo/src/index.ts", old_string: "one", new_string: "two" },
      metadata: {
        diffs: [{ path: "/repo/src/index.ts", oldText: "const a = 1", newText: "const a = 2" }],
      },
    });

    expect(strategy).toMatchObject({
      Icon: FilePenLine,
      title: "edit",
      secondaryText: "src/index.ts",
      outputContent: {
        kind: "structured-diff",
        blocks: [
          {
            label: "index.ts · /repo/src/index.ts",
            lines: [
              { type: "remove", text: "const a = 1" },
              { type: "add", text: "const a = 2" },
            ],
          },
        ],
      },
    });
  });

  it("falls back to diffing the edit arguments when no hunks were recorded", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "edit",
      input: { file_path: "/repo/src/index.ts", old_string: "one", new_string: "two" },
    });

    expect(strategy.outputContent).toMatchObject({
      kind: "structured-diff",
      blocks: [
        {
          lines: [
            { type: "remove", text: "one" },
            { type: "add", text: "two" },
          ],
        },
      ],
    });
  });

  it("keeps an unregistered DSH tool on the default card", () => {
    const strategy = buildStrategy({
      agent: "dsh",
      tool: "job_output",
      input: { job_id: "7" },
      output: "still running",
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: "job_output",
      showInputPreview: true,
      outputContent: { kind: "plain", text: "still running" },
    });
  });
});

describe("search and shell strategy contracts", () => {
  it.each([
    {
      agent: "opencode",
      tool: "Glob",
      input: { pattern: "**/*.ts" },
      title: "Glob",
      secondaryText: "**/*.ts",
    },
    {
      agent: "opencode",
      tool: "Grep",
      input: { path: "/repo/src", pattern: "TODO" },
      title: "Grep",
      secondaryText: "src · TODO",
    },
    {
      agent: "kimi",
      tool: "Glob",
      titleValue: "find files",
      input: { pattern: "**/*.tsx" },
      title: "find files",
      secondaryText: "**/*.tsx",
    },
    {
      agent: "kimi",
      tool: "Grep",
      titleValue: "search files",
      input: { path: "/repo/apps/web", pattern: "strategy" },
      title: "search files",
      secondaryText: "apps/web · strategy",
    },
    {
      agent: "zcode",
      tool: "Glob",
      input: { path: "/repo/src", pattern: "*.ts" },
      title: "glob",
      secondaryText: "src · *.ts",
    },
    {
      agent: "dsh",
      tool: "glob",
      input: { pattern: "README*" },
      title: "glob",
      secondaryText: "README*",
    },
    {
      agent: "dsh",
      tool: "grep",
      input: { path: "/repo/src", pattern: "TODO" },
      title: "grep",
      secondaryText: "src · TODO",
    },
  ])("preserves $agent $tool output", (fixture) => {
    const strategy = buildStrategy({
      agent: fixture.agent,
      tool: fixture.tool,
      title: fixture.titleValue,
      input: fixture.input,
      output: "matches",
    });

    expect(strategy).toMatchObject({
      Icon: FileSearch,
      title: fixture.title,
      secondaryText: fixture.secondaryText,
      showInputPreview: false,
      outputContent: { kind: "plain", text: "matches", language: "text", isCode: false },
    });
  });

  it.each([
    {
      agent: "opencode",
      tool: "Bash",
      input: { description: "Run checks", command: "node /repo/scripts/check.mjs" },
      title: "Bash",
      secondaryText: "Run checks (node ./scripts/check.mjs)",
    },
    {
      agent: "kimi",
      tool: "Shell",
      titleValue: "terminal",
      input: { command: "node /repo/scripts/check.mjs" },
      title: "terminal",
      secondaryText: "(node ./scripts/check.mjs)",
    },
  ])("preserves $agent shell output", (fixture) => {
    const strategy = buildStrategy({
      agent: fixture.agent,
      tool: fixture.tool,
      title: fixture.titleValue,
      input: fixture.input,
      output: "passed",
    });

    expect(strategy).toMatchObject({
      Icon: SquareTerminal,
      title: fixture.title,
      secondaryText: fixture.secondaryText,
      showInputPreview: false,
      outputContent: { kind: "plain", text: "passed", language: "text", isCode: false },
    });
  });
});

describe("Codex plan and text displays", () => {
  it.each([
    {
      part: { type: "plan", text: "# Ship\n\nRun checks", approval_status: "success" },
      approvalStatus: "success",
      expandable: true,
      contentLabel: "Plan",
      contentMarkdown: "# Ship\n\nRun checks",
    },
    {
      part: { type: "plan", text: "  ", approval_status: "fail" },
      approvalStatus: "fail",
      expandable: false,
      contentLabel: "Rejected",
      contentMarkdown: "",
    },
  ] as const)("renders $approvalStatus plan state", (fixture) => {
    expect(buildCodexPlanDisplay(fixture.part as PlanPart)).toEqual({
      title: "plan",
      secondaryText: undefined,
      approvalStatus: fixture.approvalStatus,
      expandable: fixture.expandable,
      contentLabel: fixture.contentLabel,
      contentMarkdown: fixture.contentMarkdown,
    });
  });
});
