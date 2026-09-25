import { describe, expect, it } from "vitest";
import type { MessagePart } from "../session.js";
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
        { type: "tool", tool: "Pending", state: {} },
        { type: "tool", tool: "Failed", state: { error: "nope" } },
        { type: "tool", tool: "Finished", state: { output: null } },
      ]),
    ).toEqual([
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

  it("rejects illegal variant shapes at compile time", () => {
    // @ts-expect-error Text parts cannot carry tool fields.
    const invalidText: MessagePart = { type: "text", text: "done", tool: "Bash" };
    // @ts-expect-error Text payloads must be strings.
    const invalidTextPayload: MessagePart = { type: "text", text: 42 };
    // @ts-expect-error Tool state always has an explicit status.
    const invalidTool: MessagePart = { type: "tool", tool: "Bash", state: {} };
    // @ts-expect-error Images require inline data or a URL.
    const invalidImage: MessagePart = { type: "image" };

    expect([invalidText, invalidTextPayload, invalidTool, invalidImage]).toHaveLength(4);
  });
});
