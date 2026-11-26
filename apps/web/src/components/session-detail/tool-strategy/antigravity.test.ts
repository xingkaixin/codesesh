import { describe, expect, it } from "vitest";
import type { ToolPart, ToolPartStatus } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(
  tool: string,
  input: unknown,
  output?: string,
  error?: string,
  status?: ToolPartStatus,
  includeOutput = true,
) {
  const part: ToolPart = {
    type: "tool",
    tool,
    state: { status: status ?? (error ? "error" : "completed"), input, output, error },
  };
  return getToolDisplayStrategy("antigravity-cli", part, normalizeToolState(part), "/repo", {
    includeOutput,
  });
}

describe("Antigravity tool visualization", () => {
  it("strips timestamp and line-number envelopes, surfaces ByteOffset, and preserves errors", () => {
    const raw =
      "Created At: 2026-11-19T13:48:10+08:00\nCompleted At: 2026-11-19T13:48:11+08:00\nShowing lines 10-11 of 20\n10: const pattern = /\\n/;\n11: export default pattern;";
    const read = display(
      "read_file",
      { Path: "/repo/a.ts", StartLine: 10, EndLine: 11, ByteOffset: 4096 },
      raw,
    );
    expect(read.secondaryText).toBe("a.ts");
    expect(read.details).toEqual([
      { label: "Lines", value: "10-11 / 20" },
      { label: "Offset", value: "4096" },
    ]);
    expect(read.showInputPreview).toBe(false);
    expect(read.outputContent).toEqual({
      kind: "plain",
      text: "const pattern = /\\n/;\nexport default pattern;",
      language: "typescript",
      isCode: true,
    });

    const withExtraParam = display("read_file", { Path: "/repo/a.ts", CustomFlag: true }, raw);
    expect(withExtraParam.showInputPreview).toBe(true);

    const binary = display(
      "read_file",
      { Path: "/repo/logo.png" },
      "Created At: 2026-11-19T13:48:10+08:00\nCompleted At: 2026-11-19T13:48:11+08:00\nShowing binary file of type image/png",
    );
    expect(binary.outputContent).toEqual({
      kind: "plain",
      text: "Showing binary file of type image/png",
      language: "text",
      isCode: false,
    });

    const legacyView = display(
      "view_file",
      { AbsolutePath: "/repo/a.ts" },
      "File Path: `file:///repo/a.ts`\nTotal Lines: 20\nTotal Bytes: 120\nShowing lines 1 to 2\nThe following code has been modified to include a line number.\n1: const a = 1;\n2: const b = 2;",
    );
    expect(legacyView.secondaryText).toBe("a.ts");
    expect(legacyView.details).toEqual([{ label: "Lines", value: "1-2 / 20" }]);
    expect(legacyView.outputContent).toMatchObject({
      kind: "plain",
      text: "const a = 1;\nconst b = 2;",
      language: "typescript",
      isCode: true,
    });

    expect(
      display("read_file", { Path: "/repo/a.ts" }, "partial", "invalid ByteOffset").outputContent,
    ).toMatchObject({ kind: "plain", text: "invalid ByteOffset\n\npartial", isCode: false });
  });

  it("extracts toolSummary, exit code, workdir, and full output path for run_command", () => {
    const command = display(
      "run_command",
      {
        CommandLine: "cargo test",
        Cwd: "/repo/src",
        toolSummary: "Run unit tests",
      },
      "The tool's output was truncated due to being too long. You can find the full output in a file at file:///repo/out.txt.\n\nHere is a preview with the middle of the output truncated:\nCreated At: 2026-11-19T13:48:10+08:00\nCompleted At: 2026-11-19T13:48:12+08:00\nCommand exited with code 1.\n\nCommand output:\nfailed test",
    );
    expect(command.secondaryText).toBe("Run unit tests (cargo test)");
    expect(command.details).toEqual([
      { label: "Command", value: "cargo test" },
      { label: "Workdir", value: "src" },
      { label: "Exit code", value: "1" },
      { label: "Full output", value: "out.txt" },
    ]);
    expect(command.outputContent).toEqual({
      kind: "plain",
      text: "failed test",
      language: "text",
      isCode: false,
    });

    const withWait = display(
      "run_command",
      { CommandLine: "pnpm dev", WaitMsBeforeAsync: 5000 },
      "started",
    );
    expect(withWait.showInputPreview).toBe(true);
  });

  it("retains full native receipts via rawOutput for completed edits and separates evidence when failed or unknown", () => {
    const multiLineReceipt =
      "Created At: 2026-11-19T13:54:52+08:00\nCompleted At: 2026-11-19T13:54:57+08:00\nMade 1 replacement in /repo/a.ts starting at line 1 (+1/-1 lines).\n[diff_block_start]\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;";
    const completed = display(
      "edit_file",
      { Path: "/repo/a.ts", Target: "const x = 1;", Replacement: "const x = 2;" },
      multiLineReceipt,
    );
    expect(completed.outputContent.kind).toBe("structured-diff");
    expect(completed.rawOutput).toBe(multiLineReceipt);
    expect(completed.details).toEqual([
      { label: "Result", value: "Made 1 replacement in ./a.ts starting at line 1 (+1/-1 lines)." },
    ]);

    const collapsed = display(
      "edit_file",
      { Path: "/repo/a.ts", Target: "const x = 1;", Replacement: "const x = 2;" },
      multiLineReceipt,
      undefined,
      "completed",
      false,
    );
    expect(collapsed.outputContent).toEqual({
      kind: "plain",
      text: "",
      language: "text",
      isCode: false,
    });

    for (const [status, error] of [
      ["unknown", undefined],
      ["error", "permission denied"],
    ] as const) {
      const strategy = display(
        "edit_file",
        { Path: "/repo/a.ts", Target: "const x = 1;", Replacement: "const x = 2;" },
        "native result",
        error,
        status,
      );
      const content = strategy.outputContent;
      expect(content.kind).toBe("file-sections");
      if (content.kind !== "file-sections") throw new Error("missing file evidence");
      expect(content.sections[0]).toMatchObject({
        isCode: false,
        text: error ? "permission denied\n\nnative result" : "native result",
      });
      expect(content.sections[1]).toMatchObject({ label: "Requested changes", language: "diff" });
      expect(content.sections[1]?.text).toContain("-const x = 1;");
      expect(content.sections[1]?.text).toContain("+const x = 2;");
    }
  });

  it("renders completed writes with native receipts and keeps Requested content separate when output is missing", () => {
    const code = "const pattern = /\\n/;";
    const receipt =
      "Created At: 2026-11-19T14:07:26+08:00\nCompleted At: 2026-11-19T14:07:34+08:00\nCreated file.";
    const completed = display("write_file", { Path: "/repo/a.ts", Content: code }, receipt);
    expect(completed.details).toEqual([{ label: "Result", value: "Created file." }]);
    expect(completed.rawOutput).toBe(receipt);
    expect(completed.outputContent).toEqual({
      kind: "plain",
      text: code,
      language: "typescript",
      isCode: true,
    });

    const missingOutput = display(
      "write_to_file",
      { TargetFile: "/repo/a.ts", CodeContent: code },
      undefined,
      undefined,
      "completed",
    ).outputContent;
    expect(missingOutput.kind).toBe("file-sections");
    if (missingOutput.kind !== "file-sections") throw new Error("missing file evidence");
    expect(missingOutput.sections[0]).toMatchObject({
      label: "Result",
      text: "No output captured.",
    });
    expect(missingOutput.sections[1]).toMatchObject({ label: "Requested content", text: code });
    const failedAppend = display(
      "write_file",
      { Path: "/repo/a.ts", Content: code, Append: true },
      undefined,
      "disk full",
      "error",
    );
    expect(failedAppend.details).toEqual([{ label: "Append", value: "Yes" }]);

    const timestampOnlyWrite = display(
      "write_file",
      { Path: "/repo/a.ts", Content: code, Overwrite: true },
      "Created At: 2026-11-19T14:07:26+08:00\nCompleted At: 2026-11-19T14:07:34+08:00\n",
      undefined,
      "completed",
    );
    expect(timestampOnlyWrite.showInputPreview).toBe(true);
    expect(timestampOnlyWrite.outputContent.kind).toBe("file-sections");
    if (timestampOnlyWrite.outputContent.kind !== "file-sections") {
      throw new Error("missing file evidence");
    }
    expect(timestampOnlyWrite.outputContent.sections[0]).toMatchObject({
      label: "Result",
      text: "No output captured.",
    });
    expect(timestampOnlyWrite.outputContent.sections[1]).toMatchObject({
      label: "Requested content",
      text: code,
    });
  });

  it("visualizes update_steps, ask_question, and finish while surfacing errors on failure", () => {
    const plan = display(
      "update_steps",
      {
        steps: [
          { status: "done", title: "Analyze sessions" },
          { status: "in_progress", title: "Fix rendering" },
          { status: "skipped", title: "Optional step" },
        ],
      },
      "Created At: 2026-11-26T11:33:46+08:00\nCompleted At: 2026-11-26T11:33:49+08:00\nOK",
    );
    expect(plan.outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Analyze sessions", status: "completed", detail: undefined },
        { label: "Fix rendering", status: "in_progress", detail: undefined },
        { label: "Optional step", status: "pending", detail: "skipped" },
      ],
    });

    const failedSteps = display(
      "update_steps",
      { steps: [{ status: "done", title: "Shipped" }] },
      undefined,
      "invalid steps payload",
      "error",
    );
    expect(failedSteps.outputContent).toEqual({
      kind: "plain",
      text: "invalid steps payload",
      language: "text",
      isCode: false,
    });
    expect(failedSteps.showInputPreview).toBe(true);

    const failedAsk = display(
      "ask_question",
      { questions: [{ question: "Proceed?", options: ["Yes", "No"] }] },
      undefined,
      "user dismissed prompt",
      "error",
    );
    expect(failedAsk.outputContent).toEqual({
      kind: "plain",
      text: "user dismissed prompt",
      language: "text",
      isCode: false,
    });
    expect(failedAsk.showInputPreview).toBe(true);

    const stringFinish = display(
      "finish",
      { result: "All checks passed." },
      "Created At: 2026-11-21T11:23:38+08:00\nCompleted At: 2026-11-21T11:23:39+08:00\nOK",
    );
    expect(stringFinish.outputContent).toEqual({
      kind: "plain",
      text: "All checks passed.",
      language: "text",
      isCode: false,
    });
    expect(stringFinish.rawOutput).toContain("OK");

    const failedFinish = display(
      "finish",
      { result: { ok: true } },
      undefined,
      "schema validation failed",
      "error",
    );
    expect(failedFinish.outputContent).toEqual({
      kind: "plain",
      text: "schema validation failed",
      language: "text",
      isCode: false,
    });
    expect(failedFinish.showInputPreview).toBe(true);

    const asked = display(
      "ask_question",
      {
        questions: [
          {
            is_multi_select: false,
            question: "Which merge strategy?",
            options: ["(Recommended) Squash merge", "Rebase merge"],
          },
          {
            is_multi_select: true,
            question: "Which panels?",
            options: ["Tokens (Recommended)", "Branch"],
          },
        ],
      },
      "Created At: 2026-11-15T14:35:05+08:00\nCompleted At: 2026-11-15T14:36:35+08:00\nA1: (Recommended) Squash merge\nA2: Tokens (Recommended), Branch",
    );
    expect(asked.outputContent).toEqual({
      kind: "question-list",
      questions: [
        {
          question: "Which merge strategy?",
          options: [
            { label: "Squash merge", recommended: true },
            { label: "Rebase merge", recommended: undefined },
          ],
          answers: ["Squash merge"],
          unansweredLabel: "No answer recorded",
        },
        {
          question: "Which panels?",
          options: [
            { label: "Tokens", recommended: true },
            { label: "Branch", recommended: undefined },
          ],
          answers: ["Tokens", "Branch"],
          unansweredLabel: "No answer recorded",
        },
      ],
    });
  });

  it("visualizes subagent, swarm, board, task, browser, and MCP tools while keeping omitted args inspectable", () => {
    const subagentReceipt =
      'Created At: 2026-11-19T15:47:21+08:00\nCompleted At: 2026-11-19T15:47:55+08:00\nCreated the following subagent:\n{\n  "conversationId": "sub-123"\n}\nThe subagent will send you a message.';
    const subagent = display(
      "invoke_subagent",
      {
        Role: "Codebase Researcher",
        TypeName: "research",
        Model: "inherit",
        Prompt: "Audit parser",
      },
      subagentReceipt,
    );
    expect(subagent.title).toBe("agent · research");
    expect(subagent.secondaryText).toBe("Codebase Researcher");
    expect(subagent.rawOutput).toBe(subagentReceipt);
    expect(subagent.outputContent).toMatchObject({
      kind: "property-list",
      items: [{ label: "conversationId", value: "sub-123" }],
    });

    const swarm = display(
      "swarm",
      { action: "add", name: "worker", brief: "Check parsing" },
      'Created At: 2026-11-14T10:00:00+08:00\nCompleted At: 2026-11-14T10:00:01+08:00\n{"status":"added","name":"worker","conversation_id":"child-id"}',
    );
    expect(swarm.outputContent).toMatchObject({
      kind: "property-list",
      items: expect.arrayContaining([{ label: "conversation_id", value: "child-id" }]),
    });

    const board = display(
      "read_board",
      { since: 4 },
      'Created At: 2026-11-14T10:32:04+08:00\nCompleted At: 2026-11-14T10:32:06+08:00\n{"messages":[{"seq":5,"agent":"author","text":"Done"}]}',
    );
    expect(board.outputContent).toEqual({
      kind: "property-list",
      items: [{ label: "#5 · author", value: "Done" }],
    });

    const task = display(
      "manage_task",
      { Action: "status", TaskId: "conv/task-1" },
      "Created At: 2026-11-18T12:08:24+08:00\nCompleted At: 2026-11-18T12:08:25+08:00\nTask: conv/task-1\nStatus: RUNNING\nLog: file:///repo/task.log\nLog output:\nstep ok",
    );
    expect(task.details).toEqual([
      { label: "Status", value: "RUNNING" },
      { label: "Log", value: "task.log" },
    ]);
    expect(task.outputContent).toMatchObject({ kind: "plain", text: "step ok" });

    const simpleMcp = display(
      "mcp_t3-code_pull_request_read",
      { number: 1116, include: ["checks"], toolSummary: "Check PR #1116 CI status" },
      'Created At: 2026-11-22T16:43:24+08:00\nCompleted At: 2026-11-22T16:43:34+08:00\n{"number":1116,"state":"open"}',
    );
    expect(simpleMcp.title).toBe("t3-code · pull request read");
    expect(simpleMcp.secondaryText).toBe("Check PR #1116 CI status");
    expect(simpleMcp.showInputPreview).toBe(false);
    expect(simpleMcp.outputContent).toEqual({
      kind: "property-list",
      items: [
        { label: "number", value: 1116 },
        { label: "state", value: "open" },
      ],
    });

    const legacyMcp = display(
      "call_mcp_tool",
      {
        ServerName: "t3-code",
        ToolName: "html_preview",
        Arguments: { path: "/repo/a.html", toolSummary: "Inner summary" },
        toolSummary: "Outer summary",
        toolAction: "Outer action",
      },
      '{"width":728}',
    );
    expect(legacyMcp.details).toEqual([
      { label: "path", value: "a.html" },
      { label: "toolSummary", value: "Inner summary" },
    ]);
    expect(legacyMcp.showInputPreview).toBe(true);

    const failedSilentMcp = display(
      "call_mcp_tool",
      {
        ServerName: "t3-code",
        ToolName: "delegate_task",
        Arguments: { target: { model: "gpt-6.2-sol" } },
      },
      undefined,
      undefined,
      "error",
    );
    expect(failedSilentMcp.showInputPreview).toBe(true);

    const failedPost = display(
      "post_message",
      { text: "line 1\nline 2" },
      undefined,
      "board closed",
      "error",
    );
    expect(failedPost.showInputPreview).toBe(true);

    const nestedMcp = display(
      "mcp_t3-code_delegate_task",
      {
        role: "review",
        mode: "async",
        target: { model: "gpt-6.2-sol", options: { reasoningEffort: "xhigh" } },
        toolSummary: "Start review",
      },
      '{"taskId":"t1"}',
    );
    expect(nestedMcp.showInputPreview).toBe(true);

    const browser = display(
      "webview_browser",
      { intention: "Check hero layout", observation: "Loaded", script: "page.title()" },
      'Created At: 2026-11-19T23:10:07+08:00\nCompleted At: 2026-11-19T23:10:14+08:00\n[Browser Step 2]\n{"ok":true,"action":"script"}',
    );
    expect(browser.secondaryText).toBe("Check hero layout");
    expect(browser.outputContent).toEqual({
      kind: "property-list",
      items: [
        { label: "ok", value: true },
        { label: "action", value: "script" },
      ],
    });
  });
});
