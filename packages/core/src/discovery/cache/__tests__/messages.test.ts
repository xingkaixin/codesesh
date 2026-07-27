import { describe, expect, it, vi } from "vitest";
import {
  buildMessageText,
  buildSessionContentFromMessages,
  MESSAGE_PARTS_FORMAT_VERSION,
  messageFromCachedRow,
  messageJsonFromCachedRow,
  normalizeMessages,
  toolNamesFromMetadataJson,
} from "../messages.js";
import { makeSessionData } from "./fixtures.js";

describe("cached messages", () => {
  it("round-trips optional message fields from a cache row", () => {
    const message = messageFromCachedRow({
      message_id: "m1",
      role: "assistant",
      time_created: 10,
      time_completed: 11,
      parts_json: JSON.stringify([{ type: "text", text: "done" }]),
      tokens_json: JSON.stringify({ input: 2, output: 3 }),
      cost: 0.4,
      cost_source: "recorded",
      subagent_id: "sub-1",
      nickname: "worker",
    });

    expect(message).toMatchObject({
      id: "m1",
      role: "assistant",
      tokens: { input: 2, output: 3 },
      cost: 0.4,
      cost_source: "recorded",
      subagent_id: "sub-1",
      nickname: "worker",
    });
  });

  it("streams normalized cache JSON without parsing it", () => {
    const row = {
      message_id: "m1",
      role: "assistant" as const,
      time_created: 10,
      time_completed: 11,
      parts_format_version: MESSAGE_PARTS_FORMAT_VERSION,
      parts_json: JSON.stringify([{ type: "text", text: "done" }]),
      tokens_json: JSON.stringify({ input: 2, output: 3 }),
      cost: 0.4,
      cost_source: "recorded" as const,
      subagent_id: "sub-1",
      nickname: "worker",
    };
    const parse = vi.spyOn(JSON, "parse");

    const json = messageJsonFromCachedRow(row);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();

    expect(parseCalls).toBe(0);
    expect(JSON.parse(json)).toEqual(messageFromCachedRow(row));
  });

  it("normalizes legacy tool payloads at the cache boundary", () => {
    const row = {
      message_id: "m1",
      role: "assistant" as const,
      time_created: 10,
      parts_format_version: 0,
      parts_json: JSON.stringify([
        {
          type: "tool",
          tool: "Read",
          input: { path: "src/a.ts" },
          state: { status: "success", result: "contents", duration_ms: 12 },
        },
      ]),
    };

    const expectedParts = [
      {
        type: "tool",
        tool: "Read",
        state: {
          status: "completed",
          input: { path: "src/a.ts" },
          output: "contents",
          metadata: { duration_ms: 12 },
        },
      },
    ];

    expect(messageFromCachedRow(row).parts).toEqual(expectedParts);
    expect(JSON.parse(messageJsonFromCachedRow(row)).parts).toEqual(expectedParts);
  });

  it("normalizes searchable content and unique tool names", () => {
    const session = makeSessionData("s1");
    session.messages[0]!.parts.push(
      {
        type: "tool",
        tool: " Read ",
        state: { status: "completed", input: { path: "src/a.ts" } },
      },
      { type: "tool", tool: "read", state: { status: "completed", output: true } },
    );

    const records = normalizeMessages(session);

    expect(records[0]?.toolNames).toEqual(["read"]);
    expect(buildSessionContentFromMessages(session.title, records)).toContain("src/a.ts");
    expect(buildMessageText(session.messages[0]!)).toContain("visible text");
    expect(toolNamesFromMetadataJson(JSON.stringify([{ tool: "Read" }, { tool: "read" }]))).toEqual(
      ["read"],
    );
    expect(toolNamesFromMetadataJson("not-json")).toEqual([]);
  });
});
