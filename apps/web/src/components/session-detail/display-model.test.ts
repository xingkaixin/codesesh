import { describe, expect, it } from "vitest";
import type { Message, SessionFileActivity } from "../../lib/api";
import { buildSessionDetailDisplayModel } from "./display-model";

const messages: Message[] = [
  {
    id: "duplicate",
    role: "user",
    time_created: 10,
    parts: [{ type: "text", text: "Inspect these files" }],
  },
  {
    id: "duplicate",
    role: "assistant",
    time_created: 20,
    parts: [
      { type: "reasoning", text: "Checking" },
      { type: "text", text: "I will inspect them." },
      { type: "plan", text: "Read then update", approval_status: "success" },
      {
        type: "tool",
        tool: "Read",
        time_created: 21,
        state: { status: "completed", input: { file_path: "src/a.ts" } },
      },
      {
        type: "tool",
        tool: "Write",
        time_created: 22,
        state: { status: "completed", input: { file_path: "src/b.ts" } },
      },
    ],
  },
  {
    id: "duplicate",
    role: "assistant",
    time_created: 30,
    parts: [
      {
        type: "tool",
        tool: "Read",
        state: { status: "completed", input: { file_path: "src/a.ts" } },
      },
      { type: "text", text: "Done." },
    ],
  },
];

const fileActivity: SessionFileActivity[] = [
  {
    reference: { agentName: "claudecode", sessionId: "s1" },
    projectIdentityKey: "project",
    path: "src/a.ts",
    kind: "read",
    count: 2,
    latestTime: 30,
  },
  {
    reference: { agentName: "claudecode", sessionId: "s1" },
    projectIdentityKey: "project",
    path: "src/b.ts",
    kind: "write",
    count: 1,
    latestTime: 22,
  },
];

describe("session detail display model", () => {
  it("prepares filtering, navigation, timeline, and file changes through one interface", () => {
    const model = buildSessionDetailDisplayModel({
      messages,
      agentName: "claudecode",
      fileActivity,
    });

    expect(model.messages.map((message) => message.index)).toEqual([0, 1, 2]);
    expect(model.messages.map((message) => message.msg.id)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    expect(model.toc.counts).toEqual({
      user: 1,
      agent_message: 2,
      thinking: 1,
      plan: 1,
      tools_all: 3,
    });

    const firstTools = model.messages[1]?.blocks.find((block) => block.type === "tool");
    const secondTools = model.messages[2]?.blocks.find((block) => block.type === "tool");
    expect(firstTools?.anchorIds).toEqual(["tool-1-0", "tool-1-1"]);
    expect(secondTools?.anchorIds).toEqual(["tool-2-0"]);

    expect(model.fileChangeSummary.read).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        count: 2,
        latestAnchorId: "tool-2-0",
        anchors: [
          expect.objectContaining({ anchorId: "tool-1-0" }),
          expect.objectContaining({ anchorId: "tool-2-0" }),
        ],
      }),
    ]);
    expect(model.fileChangeSummary.write).toHaveLength(1);

    const reads = model.select(new Set(["tool:read"]));
    expect(reads.messages.map((message) => message.index)).toEqual([1, 2]);
    expect(reads.timelineEntries.map((entry) => entry.anchorId)).toEqual(["tool-1-0", "tool-2-0"]);
    expect(reads.resolveListIndex(1)).toBe(0);
    expect(reads.resolveListIndex(2)).toBe(1);
    expect(model.resolveMessageIndex("tool-2-0")).toBe(2);

    const writes = model.select(new Set(["tool:write"]));
    expect(writes.messages.map((message) => message.index)).toEqual([1]);
    expect(writes.timelineEntries.map((entry) => entry.anchorId)).toEqual(["tool-1-1"]);
    expect(model.resolveMessageIndex("tool-1-1")).toBe(1);
  });

  it("returns an empty coherent selection when no messages are visible", () => {
    const model = buildSessionDetailDisplayModel({
      messages: [{ id: "empty", role: "assistant", time_created: 1, parts: [] }],
      agentName: "claudecode",
    });

    expect(model.messages).toEqual([]);
    expect(model.toc.filterIds.size).toBe(0);
    expect(model.select(new Set()).messages).toEqual([]);
  });
});
