import { describe, expect, it } from "vitest";
import type { ToolPart } from "../../../lib/api";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(name: string, input: unknown, status: "completed" | "error" = "completed") {
  const tool: ToolPart = { type: "tool", tool: name, state: { status, input, output: "done" } };
  return getToolDisplayStrategy("droid", tool, normalizeToolState(tool), "/repo");
}

describe("Droid tool display", () => {
  it("shows patch files, edit diffs and todo descriptions", () => {
    const patch = "*** Begin Patch\n*** Update File: /repo/src/a.ts\n@@\n-a\n+b\n*** End Patch";
    expect(display("ApplyPatch", { input: patch })).toMatchObject({
      title: "edit",
      secondaryText: "src/a.ts",
      outputContent: { kind: "plain", text: patch, language: "diff" },
    });
    expect(
      display("Edit", { file_path: "/repo/a.ts", old_str: "a", new_str: "b" }).outputContent.kind,
    ).toBe("structured-diff");
    expect(
      display("Edit", { file_path: "/repo/a.ts", old_str: "a", new_str: "b" }, "error")
        .outputContent.kind,
    ).toBe("plain");
    expect(
      display("TodoWrite", { todos: [{ description: "Check", status: "in_progress" }] })
        .outputContent,
    ).toEqual({ kind: "task-list", items: [{ label: "Check", status: "in_progress" }] });
  });
});
