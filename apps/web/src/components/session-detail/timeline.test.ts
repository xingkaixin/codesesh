import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import type { FilteredSessionMessage } from "./toc";
import {
  buildBlockTimelineAnchorId,
  buildMessageTimelineAnchorId,
  buildSessionTimelineEntries,
  findActiveTimelineIndex,
  findTimelineEdgeIndex,
  findTimelineIndexAtPointer,
  summarizeTimelineText,
} from "./timeline";

function message(id: string, role: Message["role"]): Message {
  return { id, role, time_created: 1, parts: [] };
}

describe("session timeline", () => {
  it("builds user, agent, and individual tool entries in display order", () => {
    const readTool: MessagePart = { type: "tool", tool: "Read" };
    const writeTool: MessagePart = { type: "tool", title: "Tool: Write" };
    const messages: FilteredSessionMessage[] = [
      {
        msg: message("user", "user"),
        index: 4,
        blocks: [{ type: "text", parts: [{ type: "text", text: "  Open\nthis file  " }] }],
      },
      {
        msg: message("assistant", "assistant"),
        index: 7,
        blocks: [
          { type: "reasoning", parts: [{ type: "reasoning", text: "Checking it" }] },
          { type: "tool", parts: [readTool, writeTool] },
          { type: "text", parts: [{ type: "text", text: "Done" }] },
        ],
      },
    ];
    const toolAnchorIds = new Map<MessagePart, string>([
      [readTool, "tool-7-0"],
      [writeTool, "tool-7-1"],
    ]);

    const entries = buildSessionTimelineEntries(messages, toolAnchorIds);

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "agent", "tool", "tool", "agent"]);
    expect(entries.map((entry) => entry.anchorId)).toEqual([
      buildMessageTimelineAnchorId(4),
      buildBlockTimelineAnchorId(7, 0),
      "tool-7-0",
      "tool-7-1",
      buildBlockTimelineAnchorId(7, 2),
    ]);
    expect(entries.map((entry) => entry.tooltip)).toEqual([
      "User · Open this file",
      "Agent · Checking it",
      "Tool · Read",
      "Tool · Write",
      "Agent · Done",
    ]);
  });

  it("compacts and limits message summaries", () => {
    const summary = summarizeTimelineText(`  ${"a".repeat(80)}\n next  `);
    expect(summary).toBe(`${"a".repeat(48)}…`);
    expect(summarizeTimelineText("# Heading <!-- --> with **bold** and `code`")).toBe(
      "Heading with bold and code",
    );
  });

  it("selects the last anchor above the viewport center", () => {
    expect(
      findActiveTimelineIndex(
        [
          { index: 3, top: 500 },
          { index: 1, top: 100 },
          { index: 2, top: 300 },
        ],
        420,
      ),
    ).toBe(2);
    expect(findActiveTimelineIndex([{ index: 3, top: 500 }], 100)).toBe(3);
    expect(findActiveTimelineIndex([], 100)).toBeNull();
  });

  it("prioritizes the first and last entries at scroll boundaries", () => {
    expect(findTimelineEdgeIndex(0, 400, 1_000, 8)).toBe(0);
    expect(findTimelineEdgeIndex(0.5, 400, 1_000, 8)).toBe(0);
    expect(findTimelineEdgeIndex(599.5, 400, 1_000, 8)).toBe(7);
    expect(findTimelineEdgeIndex(300, 400, 1_000, 8)).toBeNull();
    expect(findTimelineEdgeIndex(0, 400, 300, 8)).toBe(0);
    expect(findTimelineEdgeIndex(0, 400, 1_000, 0)).toBeNull();
  });

  it("maps pointer position to a clamped timeline entry", () => {
    expect(findTimelineIndexAtPointer(150, 100, 200, 4)).toBe(1);
    expect(findTimelineIndexAtPointer(50, 100, 200, 4)).toBe(0);
    expect(findTimelineIndexAtPointer(400, 100, 200, 4)).toBe(3);
    expect(findTimelineIndexAtPointer(100, 100, 0, 4)).toBeNull();
  });
});
