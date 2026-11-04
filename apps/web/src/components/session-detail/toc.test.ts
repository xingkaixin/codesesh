import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "@codesesh/contract";
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

describe("session detail toc", () => {
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
    expect(toc.totalUnitCount).toBe(6);
    expect(toc.maxToolCount).toBe(1);
    expect(toc.tools.map((tool) => `${tool.label}:${tool.count}:${tool.kind}`)).toEqual([
      "Read:1:read",
      "Write:1:write",
    ]);

    const filtered = filterSessionMessages(models, new Set(["tool:read"]));

    expect(filtered.messages).toHaveLength(1);
    expect(filtered.visibleUnitCount).toBe(1);
    expect(filtered.messages[0]?.index).toBe(1);
    expect(filtered.messages[0]?.msg.id).toBe("assistant");
    expect(filtered.messages[0]?.blocks).toMatchObject([{ type: "tool", parts: [readTool] }]);
  });
  it("counts and filters tool parts inside user messages", () => {
    const bashTool = {
      type: "tool",
      tool: "Bash",
      state: { status: "completed" },
    } satisfies MessagePart;
    const models = buildModels([
      createMessage("user", "user", [{ type: "text", text: "run it" }, bashTool]),
    ]);

    const toc = buildSessionDetailToc(models);

    expect(toc.counts.user).toBe(1);
    expect(toc.counts.tools_all).toBe(1);
    expect(toc.tools.map((tool) => tool.id)).toEqual(["tool:bash"]);
    expect(toc.totalUnitCount).toBe(2);

    const userOnly = filterSessionMessages(models, new Set(["user"]));
    expect(userOnly.visibleUnitCount).toBe(1);
    expect(userOnly.messages[0]?.blocks.map((block) => block.type)).toEqual(["text"]);

    const toolOnly = filterSessionMessages(models, new Set(["tool:bash"]));
    expect(toolOnly.visibleUnitCount).toBe(1);
    expect(toolOnly.messages[0]?.blocks.map((block) => block.type)).toEqual(["tool"]);
  });
});
