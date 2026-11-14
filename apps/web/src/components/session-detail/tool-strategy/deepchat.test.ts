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
});
