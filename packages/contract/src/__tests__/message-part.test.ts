import { describe, expect, it } from "vitest";
import { normalizeMessageParts } from "../message-part.js";

describe("message part contract", () => {
  it("normalizes legacy payload locations into the strict contract", () => {
    expect(
      normalizeMessageParts([
        { type: "text", text: "done", tool: "Bash" },
        {
          type: "tool",
          title: "Tool: Read",
          state: {
            status: "success",
            arguments: { path: "src/a.ts" },
            result: "contents",
            meta: { source: "legacy" },
            duration_ms: 12,
          },
        },
        {
          type: "tool",
          tool: "Write",
          input: { path: "src/b.ts" },
          output: "written",
        },
        {
          type: "plan",
          approval_status: "fail",
          output: { content: "Use a smaller change" },
        },
        { type: "image" },
      ]),
    ).toEqual([
      { type: "text", text: "done" },
      {
        type: "tool",
        tool: "Read",
        title: "Tool: Read",
        state: {
          status: "completed",
          input: { path: "src/a.ts" },
          output: "contents",
          metadata: { source: "legacy", duration_ms: 12 },
        },
      },
      {
        type: "tool",
        tool: "Write",
        state: {
          status: "completed",
          input: { path: "src/b.ts" },
          output: "written",
        },
      },
      {
        type: "plan",
        text: "Use a smaller change",
        approval_status: "fail",
      },
    ]);
  });

  it("derives explicit tool statuses when legacy state omitted them", () => {
    expect(
      normalizeMessageParts([
        { type: "tool", tool: "Unknown", state: { status: "unknown", output: null } },
        { type: "tool", tool: "Pending", state: {} },
        { type: "tool", tool: "Failed", state: { error: "nope" } },
        { type: "tool", tool: "Finished", state: { output: null } },
      ]),
    ).toEqual([
      { type: "tool", tool: "Unknown", state: { status: "unknown", output: null } },
      { type: "tool", tool: "Pending", state: { status: "running" } },
      {
        type: "tool",
        tool: "Failed",
        state: { status: "error", error: "nope" },
      },
      {
        type: "tool",
        tool: "Finished",
        state: { status: "completed", output: null },
      },
    ]);
  });
});
