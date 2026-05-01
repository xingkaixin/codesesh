import { describe, expect, it } from "vitest";
import { classifySessionTags } from "../smart-tags.js";
import type { SessionData } from "../../types/index.js";

function makeSession(messages: SessionData["messages"]): SessionData {
  return {
    id: "s1",
    title: "Session",
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: messages.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages,
  };
}

describe("classifySessionTags", () => {
  it("tags user intent from text", () => {
    const session = makeSession([
      {
        id: "m1",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "fix the crash and simplify the parser" }],
      },
    ]);

    expect(classifySessionTags(session)).toEqual(["bugfix", "refactoring"]);
  });

  it("tags tool-driven testing, git, docs, and planning", () => {
    const session = makeSession([
      {
        id: "m1",
        role: "assistant",
        time_created: 1,
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { arguments: { cmd: "pnpm test && git commit -m ok && pnpm build" } },
          },
          {
            type: "tool",
            tool: "patch",
            state: { arguments: [{ path: "README.md" }] },
          },
          { type: "plan", text: "1. Ship it" },
        ],
      },
    ]);

    expect(classifySessionTags(session)).toEqual([
      "testing",
      "docs",
      "git-ops",
      "build-deploy",
      "planning",
    ]);
  });

  it("tags exploration when reads dominate edits", () => {
    const session = makeSession([
      {
        id: "m1",
        role: "assistant",
        time_created: 1,
        parts: [
          { type: "tool", tool: "Read" },
          { type: "tool", tool: "Grep" },
          { type: "tool", tool: "WebSearch" },
          { type: "tool", tool: "Edit" },
        ],
      },
    ]);

    expect(classifySessionTags(session)).toEqual(["exploration"]);
  });
});
