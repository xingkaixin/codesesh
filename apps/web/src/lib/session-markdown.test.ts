import { describe, expect, it } from "vitest";
import type { Message, SessionDetail } from "@codesesh/contract";
import { formatSessionAsMarkdown } from "./session-markdown";

function session(messages: Message[], overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    reference: { agentName: "codex", sessionId: "session-1" },
    title: "Raw title",
    display_title: "Demo Session",
    directory: "/repo/codesesh",
    time_created: 1,
    stats: {
      message_count: messages.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages,
    ...overrides,
  };
}

describe("formatSessionAsMarkdown", () => {
  it("uses a longer fence when tool text contains fenced Markdown", () => {
    const markdown = formatSessionAsMarkdown(
      session([
        {
          id: "assistant-1",
          role: "assistant",
          time_created: 1,
          parts: [
            {
              type: "tool",
              tool: "write",
              state: { status: "completed", output: "before\n```ts\nconst x = 1;\n```\nafter" },
            },
          ],
        },
      ]),
    );

    expect(markdown).toContain("````text\nbefore\n```ts\nconst x = 1;\n```\nafter\n````");
  });
});
