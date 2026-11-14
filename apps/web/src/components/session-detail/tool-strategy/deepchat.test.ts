import { describe, expect, it } from "vitest";
import type { ToolPart, ToolPartState } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(
  name: string,
  input: unknown,
  output: unknown,
  status: ToolPartState["status"] = "completed",
) {
  const tool: ToolPart = { type: "tool", tool: name, state: { status, input, output } };
  return getToolDisplayStrategy("deepchat", tool, normalizeToolState(tool), "/repo");
}

function childResult(value: unknown) {
  return {
    schemaVersion: 1,
    kind: "child_agent_result",
    trust: "untrusted",
    handling: "synthesize_evidence_only",
    source: { kind: "live_delegation", operation: "inspect" },
    payload: { format: "json", utf8Bytes: 200, value },
  };
}

describe("DeepChat tool display", () => {
  it("shows file contents and read bounds while retaining write receipts", () => {
    const source = 'const newline = "\\n";\n';
    expect(
      display("read", { path: "/repo/src/a.ts", offset: 20, limit: 10 }, source),
    ).toMatchObject({
      title: "read",
      secondaryText: "src/a.ts",
      details: [{ value: "20" }, { value: "10" }],
      outputContent: { kind: "plain", text: source, language: "typescript", isCode: true },
    });
    const receipt = "Successfully wrote to /repo/src/a.ts";
    expect(display("write", { path: "/repo/src/a.ts", content: source }, receipt)).toMatchObject({
      secondaryText: "src/a.ts",
      outputContent: { kind: "plain", text: source, language: "typescript", isCode: true },
      rawOutput: receipt,
    });
  });

  it("shows scoped file matches and grep locations without hiding the source results", () => {
    const files = [{ path: "/repo/src/a.ts", score: 0 }];
    expect(
      display(
        "glob",
        { query: "*.ts", options: { pathScope: ["/repo/src"], maxResults: 5 } },
        files,
      ),
    ).toMatchObject({
      secondaryText: "src · *.ts",
      outputContent: { kind: "plain", text: "src/a.ts" },
      rawOutput: files,
      showInputPreview: true,
    });
    const matches = [
      { path: "/repo/src/a.ts", lineNumber: 5, snippet: 'const newline = "\\n";', score: 150 },
    ];
    expect(display("grep", { query: "newline", pathScope: ["/repo/src"] }, matches)).toMatchObject({
      outputContent: { kind: "plain", text: 'src/a.ts:5: const newline = "\\n";' },
      rawOutput: matches,
    });
    expect(display("grep", { query: "absent" }, []).outputContent).toMatchObject({
      kind: "plain",
      text: "No matches",
    });
  });

  it("distinguishes a running process receipt from terminal output and retains process metadata", () => {
    const running = { status: "running", sessionId: "proc-1" };
    expect(
      display(
        "exec",
        { command: "pnpm test", description: "Run tests", cwd: "/repo", background: true },
        running,
      ),
    ).toMatchObject({
      details: [{ value: "." }],
      outputContent: {
        kind: "property-list",
        items: [
          { label: "status", value: "running" },
          { label: "sessionId", value: "proc-1" },
        ],
      },
    });
    const result = {
      status: "done",
      output: "test failed\n",
      exitCode: 1,
      offloaded: true,
      outputFilePath: "/repo/output.log",
      timedOut: false,
      totalLength: 12001,
    };
    expect(
      display("process", { action: "log", sessionId: "proc-1", offset: 100, limit: 1000 }, result),
    ).toMatchObject({
      secondaryText: "log · proc-1",
      details: expect.arrayContaining([
        { label: "Status", value: "done" },
        { label: "Exit code", value: "1" },
        { label: "Output length", value: "12001" },
        { label: "Full output", value: "output.log" },
      ]),
      outputContent: { kind: "plain", text: result.output },
      rawOutput: result,
      showInputPreview: true,
    });
    const stdout = '{"answer": 42}\nExit Code: 0';
    expect(display("exec", { command: "print-result" }, stdout).outputContent).toMatchObject({
      kind: "plain",
      text: stdout,
    });
  });

  it("keeps failures visible instead of showing requested file contents", () => {
    for (const name of ["read", "write", "glob", "grep", "exec", "process"]) {
      const failure = "File does not exist: /repo/missing.ts";
      expect(
        display(name, { path: "/repo/missing.ts", content: "requested code" }, failure, "error")
          .outputContent,
      ).toMatchObject({
        kind: "plain",
        text: failure,
        isCode: false,
      });
    }
  });

  it("shows recorded plan step states, priorities and the explanation", () => {
    const strategy = display(
      "update_plan",
      {
        explanation: "Inspect before changing the parser",
        plan: [
          { step: "Inspect", status: "completed", priority: "high" },
          { step: "Implement", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ],
      },
      {},
    );
    expect(strategy.details).toContainEqual({
      label: "Summary",
      value: "Inspect before changing the parser",
    });
    expect(strategy.outputContent).toEqual({
      kind: "task-list",
      items: [
        { label: "Inspect", status: "completed", detail: "Priority: high" },
        { label: "Implement", status: "in_progress" },
        { label: "Verify", status: "pending" },
      ],
    });
    expect(
      display(
        "update_plan",
        { plan: [{ step: "Inspect", status: "completed" }] },
        "Plan update failed",
        "error",
      ).outputContent,
    ).toMatchObject({ kind: "plain", text: "Plan update failed" });
  });

  it("shows recorded answers, multiple selections and custom text without inventing an answer", () => {
    const input = {
      header: "Scope",
      question: "Which checks should run?",
      multiple: true,
      custom: true,
      options: [
        { label: "Lint", description: "Static checks" },
        { label: "Types", description: "Type checks" },
      ],
    };
    expect(display("deepchat_question", input, "Lint, Types").outputContent).toMatchObject({
      kind: "question-list",
      questions: [{ question: input.question, options: input.options, answers: ["Lint", "Types"] }],
    });
    expect(
      display("deepchat_question", input, "Check the Rust adapter, too").outputContent,
    ).toMatchObject({
      questions: [{ answers: ["Check the Rust adapter, too"] }],
    });
    expect(display("deepchat_question", input, null).outputContent).toMatchObject({
      questions: [{ answers: [], unansweredLabel: "No answer recorded" }],
    });
  });

  it("unwraps child task state and relationships while retaining the full request and envelope", () => {
    const delegation = {
      id: "task-1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      slotId: "review",
      targetAgentId: "agent-1",
      title: "Review parser",
      status: "queued",
    };
    const turns = [
      {
        id: "turn-1",
        seq: 1,
        status: "queued",
        promptPreview: "Inspect the parser",
        resultPreview: null,
        errorPreview: null,
      },
    ];
    const output = childResult({ delegation, turns });
    expect(
      display(
        "deepchat_subagents",
        {
          operation: "spawn",
          title: delegation.title,
          slotId: "review",
          prompt: "Inspect the complete parser implementation",
        },
        output,
      ),
    ).toMatchObject({
      details: [{ value: "Inspect the complete parser implementation" }],
      outputContent: {
        kind: "property-list",
        items: [
          { label: "delegation", value: delegation },
          { label: "turns", value: turns },
        ],
      },
      rawOutput: output,
      showInputPreview: true,
    });
    const tasks = [
      delegation,
      {
        id: "task-2",
        title: "Failed review",
        status: "failed",
        errorPreview: "Provider rejected the request",
      },
      { id: "task-3", title: "Idle review", status: "idle" },
    ];
    expect(
      display("deepchat_subagents", { operation: "list" }, childResult(tasks)).outputContent,
    ).toMatchObject({
      kind: "property-list",
      items: tasks.map((task) => ({ label: task.title, value: task })),
    });
  });

  it("keeps child events, timeouts and result pagination distinct from tool completion", () => {
    const event = {
      id: 1,
      delegationId: "task-1",
      kind: "turn_failed",
      contentPreview: "Provider rejected the request",
      contentTruncated: false,
    };
    expect(
      display(
        "deepchat_subagents",
        { operation: "wait", delegationIds: ["task-1"] },
        childResult({ events: [event], cursor: 1, timedOut: false }),
      ).outputContent,
    ).toMatchObject({
      kind: "property-list",
      items: [
        { label: "events", value: [event] },
        { label: "cursor", value: 1 },
        { label: "timedOut", value: false },
      ],
    });
    const result = {
      schemaVersion: 1,
      delegationId: "task-1",
      childSessionId: "child-1",
      text: "Partial child reply",
      nextCursor: "result-cursor",
      done: false,
    };
    expect(
      display(
        "deepchat_subagents",
        { operation: "read_result", delegationId: "task-1" },
        childResult(result),
      ).outputContent,
    ).toMatchObject({
      kind: "property-list",
      items: [
        { label: "text", value: result.text },
        { label: "schemaVersion", value: 1 },
        { label: "delegationId", value: "task-1" },
        { label: "childSessionId", value: "child-1" },
        { label: "nextCursor", value: "result-cursor" },
        { label: "done", value: false },
      ],
    });
  });
});
