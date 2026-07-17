import { describe, expect, it } from "vitest";
import {
  buildMessageText,
  buildSessionContentFromMessages,
  messageFromCachedRow,
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

  it("normalizes searchable content and unique tool names", () => {
    const session = makeSessionData("s1");
    session.messages[0]!.parts.push(
      { type: "tool", tool: " Read ", input: { path: "src/a.ts" } },
      { type: "tool", tool: "read", output: true },
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
