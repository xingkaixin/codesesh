import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import { buildSessionDetailDisplayModel } from "./display-model";
import { buildSessionDetailToc, filterSessionMessages } from "./toc";

function createMessage(id: string, role: Message["role"], parts: MessagePart[]): Message {
  return {
    id,
    role,
    time_created: 100,
    parts,
  };
}

function buildModels(messages: Message[]) {
  return buildSessionDetailDisplayModel({ messages, agentName: "claudecode" }).messages;
}

describe("session detail display model", () => {
  it("builds visible message blocks once for downstream consumers", () => {
    const messages = [
      createMessage("empty", "assistant", [{ type: "text", text: "   " }]),
      createMessage("visible", "assistant", [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
        {
          type: "tool",
          tool: "Read",
          state: { status: "completed", input: { path: "a.ts" } },
        },
      ]),
    ];

    const models = buildModels(messages);

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
      state: { status: "completed", input: { path: "a.ts" } },
    } satisfies MessagePart;
    const writeTool = {
      type: "tool",
      tool: "Write",
      state: { status: "completed", input: { path: "a.ts" } },
    } satisfies MessagePart;
    const models = buildModels([
      createMessage("user", "user", [{ type: "text", text: "open file" }]),
      createMessage("assistant", "assistant", [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
        { type: "plan", text: "plan", approval_status: "success" },
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
    expect(filtered[0]?.blocks).toMatchObject([{ type: "tool", parts: [readTool] }]);
  });

  it("filters tool items without requiring the Tools parent filter", () => {
    const readTool = {
      type: "tool",
      tool: "Read",
      state: { status: "completed", input: { path: "a.ts" } },
    } satisfies MessagePart;
    const writeTool = {
      type: "tool",
      tool: "Write",
      state: { status: "completed", input: { path: "b.ts" } },
    } satisfies MessagePart;
    const models = buildModels([createMessage("assistant", "assistant", [readTool, writeTool])]);

    const filtered = filterSessionMessages(models, new Set(["tool:read"]));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.blocks).toMatchObject([{ type: "tool", parts: [readTool] }]);
  });

  it("normalizes legacy leading-dot tool labels", () => {
    const jsTool = {
      type: "tool",
      tool: ".js",
      title: "Tool: .js",
      state: { status: "completed" },
    } satisfies MessagePart;
    const models = buildModels([createMessage("assistant", "assistant", [jsTool])]);

    const toc = buildSessionDetailToc(models);
    expect(toc.tools).toEqual([{ id: "tool:js", toolKey: "js", label: "js", count: 1 }]);

    const filtered = filterSessionMessages(models, new Set(["tools_all", "tool:js"]));
    expect(filtered[0]?.blocks).toMatchObject([{ type: "tool", parts: [jsTool] }]);
  });

  it("labels Codex node repl js tools as Browser", () => {
    const browserTool = {
      type: "tool",
      tool: "js",
      title: "Tool: js",
      state: {
        status: "completed",
        metadata: { name: "js", namespace: "mcp__node_repl__" },
      },
    } satisfies MessagePart;
    const models = buildModels([createMessage("assistant", "assistant", [browserTool])]);

    const toc = buildSessionDetailToc(models);
    expect(toc.tools).toEqual([
      { id: "tool:browser", toolKey: "browser", label: "Browser", count: 1 },
    ]);

    const filtered = filterSessionMessages(models, new Set(["tools_all", "tool:browser"]));
    expect(filtered[0]?.blocks).toMatchObject([{ type: "tool", parts: [browserTool] }]);
  });
});
