import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import { buildMessageDisplayModels } from "./display-model";
import { buildSessionDetailToc, filterSessionMessages } from "./toc";

function createMessage(id: string, role: Message["role"], parts: MessagePart[]): Message {
  return {
    id,
    role,
    time_created: 100,
    parts,
  };
}

describe("session detail display model", () => {
  it("builds visible message blocks once for downstream consumers", () => {
    const messages = [
      createMessage("empty", "assistant", [{ type: "text", text: "   " }]),
      createMessage("visible", "assistant", [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
        { type: "tool", tool: "Read", state: { input: { path: "a.ts" } } },
      ]),
    ];

    const models = buildMessageDisplayModels(messages);

    expect(models).toHaveLength(1);
    expect(models[0]?.index).toBe(0);
    expect(models[0]?.msg.id).toBe("visible");
    expect(models[0]?.blocks.map((block) => block.type)).toEqual(["text", "tool"]);
    expect(models[0]?.blocks[0]?.parts).toHaveLength(2);
  });

  it("reuses display blocks for toc counts and message filtering", () => {
    const readTool = {
      type: "tool",
      tool: "Read",
      title: "tool: Read",
      state: { input: { path: "a.ts" } },
    } satisfies MessagePart;
    const writeTool = {
      type: "tool",
      tool: "Write",
      state: { input: { path: "a.ts" } },
    } satisfies MessagePart;
    const models = buildMessageDisplayModels([
      createMessage("user", "user", [{ type: "text", text: "open file" }]),
      createMessage("assistant", "assistant", [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
        { type: "plan", text: "plan" },
        readTool,
        writeTool,
      ]),
    ]);

    const toc = buildSessionDetailToc(models);

    expect(toc.counts).toEqual({
      user: 1,
      agent_message: 1,
      thinking: 1,
      plan: 1,
      tools_all: 2,
    });
    expect(toc.tools.map((tool) => `${tool.label}:${tool.count}`)).toEqual(["Read:1", "Write:1"]);

    const filtered = filterSessionMessages(models, new Set(["tools_all", "tool:read"]));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.index).toBe(1);
    expect(filtered[0]?.msg.id).toBe("assistant");
    expect(filtered[0]?.blocks).toEqual([{ type: "tool", parts: [readTool] }]);
  });
});
