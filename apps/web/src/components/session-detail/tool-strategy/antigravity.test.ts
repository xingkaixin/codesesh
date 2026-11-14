import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(tool: string, input: unknown, output?: string, error?: string) {
  const part: ToolPart = {
    type: "tool",
    tool,
    state: { status: error ? "error" : "unknown", input, output, error },
  };
  return getToolDisplayStrategy("antigravity-cli", part, normalizeToolState(part), "/repo");
}

describe("Antigravity native tool evidence", () => {
  it("shows PascalCase file and command inputs while retaining exact results and errors", () => {
    const text = "Showing lines 10-10 of 20\n10: const pattern = /\\n/;";
    const read = display("read_file", { Path: "/repo/a.ts", StartLine: 10, EndLine: 10 }, text);
    expect(read.secondaryText).toBe("a.ts");
    expect(read.outputContent).toMatchObject({ kind: "plain", text, language: "typescript" });
    expect(display("view_file", { AbsolutePath: "/repo/a.ts" }, text).secondaryText).toBe("a.ts");
    expect(
      display("read_file", { Path: "/repo/a.ts" }, "partial", "invalid ByteOffset").outputContent,
    ).toMatchObject({ kind: "plain", text: "invalid ByteOffset\n\npartial", isCode: false });

    const command = display(
      "run_command",
      { CommandLine: "printf '%s' '\\n'", Cwd: "/repo/src" },
      "Command exited with code 1.\nfailed",
    );
    expect(command.details.map(({ value }) => value)).toEqual(["printf '%s' '\\n'", "src"]);
    expect(command.outputContent).toMatchObject({
      kind: "plain",
      text: "Command exited with code 1.\nfailed",
    });
  });

  it.each([undefined, "permission denied"])(
    "keeps actual edit results ahead of requested diffs when error is %s",
    (error) => {
      const strategy = display(
        "edit_file",
        { Path: "/repo/a.ts", Target: "const x = 1;", Replacement: "const x = 2;" },
        "native result",
        error,
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
      expect(strategy.showInputPreview).toBe(true);
    },
  );

  it("retains requested write content and legacy replacement parameters separately", () => {
    const code = "const pattern = /\\n/;";
    for (const [tool, input] of [
      ["write_file", { Path: "/repo/a.ts", Content: code }],
      ["write_to_file", { TargetFile: "/repo/a.ts", CodeContent: code }],
    ] as const) {
      const content = display(tool, input, "Created file.").outputContent;
      expect(content.kind).toBe("file-sections");
      if (content.kind !== "file-sections") throw new Error("missing file evidence");
      expect(content.sections[0]?.text).toBe("Created file.");
      expect(content.sections[1]).toMatchObject({ label: "Requested content", text: code });
    }
    const edit = display("replace_file_content", {
      TargetFile: "/repo/a.ts",
      TargetContent: "const a = /\\n/;",
      ReplacementContent: code,
    }).outputContent;
    if (edit.kind !== "file-sections") throw new Error("missing file evidence");
    expect(edit.sections[1]?.text).toContain("+const pattern = /\\n/;");
  });

  it("shows swarm receipts without guessing child identity from names", () => {
    const strategy = display(
      "swarm",
      { action: "add", name: "worker", brief: "Check parsing" },
      'Created At: 2026-11-14T10:00:00+08:00\nCompleted At: 2026-11-14T10:00:01+08:00\n{"status":"added","name":"worker","conversation_id":"child-id"}',
    );
    expect(strategy.outputContent).toMatchObject({
      kind: "property-list",
      items: expect.arrayContaining([{ label: "conversation_id", value: "child-id" }]),
    });
    expect(strategy.showInputPreview).toBe(true);
    expect(
      display("swarm", { action: "add", name: "worker" }, undefined, "failed to share workspace")
        .outputContent,
    ).toMatchObject({ kind: "plain", text: "failed to share workspace" });
  });
});
