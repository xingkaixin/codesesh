import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import type { MessageBlock } from "./blocks";
import { buildMessageDisplayModels, type MessageDisplayModel } from "./display-model";
import { buildSessionDetailToc, filterSessionMessages } from "./toc";

function message(id: string, role: Message["role"], parts: MessagePart[]): Message {
  return {
    id,
    role,
    time_created: 1,
    parts,
  };
}

describe("session detail display model", () => {
  it("builds visible message models once in display order", () => {
    const userPart: MessagePart = { type: "text", text: "hello" };
    const toolPart: MessagePart = { type: "tool", tool: "read" };
    const models = buildMessageDisplayModels([
      message("empty", "assistant", [{ type: "text", text: "   " }]),
      message("user", "user", [userPart]),
      message("tool", "assistant", [toolPart]),
    ]);

    expect(models.map((model) => model.msg.id)).toEqual(["user", "tool"]);
    expect(models.map((model) => model.index)).toEqual([0, 1]);
    expect(models[0]?.blocks).toEqual([{ type: "text", parts: [userPart] }]);
    expect(models[1]?.blocks).toEqual([{ type: "tool", parts: [toolPart] }]);
  });

  it("reuses precomputed blocks for toc and filtering", () => {
    const textPart: MessagePart = { type: "text", text: "precomputed reply" };
    const readPart: MessagePart = { type: "tool", tool: "Read" };
    const writePart: MessagePart = { type: "tool", tool: "Write" };
    const blocks: MessageBlock[] = [
      { type: "text", parts: [textPart] },
      { type: "tool", parts: [readPart, writePart] },
    ];
    const models: MessageDisplayModel[] = [
      {
        msg: message("assistant", "assistant", []),
        blocks,
        index: 7,
      },
    ];

    const toc = buildSessionDetailToc(models);
    expect(toc.counts.agent_message).toBe(1);
    expect(toc.counts.tools_all).toBe(2);
    expect(toc.tools.map((tool) => tool.id)).toEqual(["tool:read", "tool:write"]);

    const filtered = filterSessionMessages(
      models,
      new Set(["agent_message", "tools_all", "tool:read"]),
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.index).toBe(7);
    expect(filtered[0]?.blocks).toEqual([
      { type: "text", parts: [textPart] },
      { type: "tool", parts: [readPart] },
    ]);
  });
});
