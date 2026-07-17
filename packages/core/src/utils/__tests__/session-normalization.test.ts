import { describe, expect, it } from "vitest";
import {
  cleanParsedMessages,
  filtered,
  firstUserMessageTitle,
  parsed,
  skipped,
} from "../session-normalization.js";
import type { Message } from "../../types/index.js";

describe("session normalization", () => {
  it("constructs each parse outcome without empty optional fields", () => {
    expect(parsed("data")).toEqual({ status: "parsed", data: "data" });
    expect(skipped()).toEqual({ status: "skipped" });
    expect(filtered("hidden")).toEqual({ status: "filtered", reason: "hidden" });
  });

  it("removes internal-only parts and deeply cleans tool payloads", () => {
    const messages: Message[] = [
      {
        id: "empty",
        role: "assistant",
        time_created: 1,
        parts: [{ type: "text", text: "<command-name>clear</command-name>" }],
      },
      {
        id: "visible",
        role: "user",
        time_created: 2,
        parts: [
          { type: "text", text: "Fix search\n<system-reminder>private</system-reminder>" },
          {
            type: "tool",
            tool: "read",
            input: { path: "src/a.ts", prompt: "<command-message>hidden</command-message>" },
          },
        ],
      },
    ];

    const cleaned = cleanParsedMessages(messages);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]?.parts[1]?.input).toEqual({ path: "src/a.ts", prompt: "" });
    expect(firstUserMessageTitle(cleaned)).toBe("Fix search");
  });
});
