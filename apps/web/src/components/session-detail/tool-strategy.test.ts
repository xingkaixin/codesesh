import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../../lib/api";
import {
  formatMessageTime,
  formatTokens,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./tool-strategy";

function part(overrides?: Partial<MessagePart>): MessagePart {
  return { role: "tool", tool: "Read", title: "Read", state: {}, ...overrides } as MessagePart;
}

describe("normalizeToolState", () => {
  it("extracts input/output/error from tool state", () => {
    const state = normalizeToolState(
      part({
        state: { arguments: { file: "/a.ts" }, status: "completed", output: "content" },
      }),
    );
    expect(state.status).toBe("completed");
    expect(state.inputValue).toEqual({ file: "/a.ts" });
    expect(state.outputValue).toBe("content");
  });

  it("reads command from input", () => {
    const state = normalizeToolState(
      part({ state: { arguments: '{"cmd":"ls"}', status: "completed" } }),
    );
    expect(state.command).toBe("ls");
  });
});

describe("getToolDisplayStrategy", () => {
  it("routes to a per-agent builder", () => {
    const state = normalizeToolState(
      part({ tool: "read", title: "read", state: { status: "completed" } }),
    );
    const strategy = getToolDisplayStrategy(
      "claudecode",
      part({ tool: "read", title: "read" }),
      state,
    );
    expect(strategy).toBeDefined();
    expect(strategy.title).toBeTruthy();
  });
});

describe("formatTokens", () => {
  it("formats thousands and millions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("formatMessageTime", () => {
  it("formats a millisecond timestamp", () => {
    const result = formatMessageTime(Date.now());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getAssistantDisplayLabel", () => {
  it("returns USER for user role", () => {
    expect(getAssistantDisplayLabel({ role: "user" } as Message)).toBe("USER");
  });

  it("returns AGENT for assistant role", () => {
    expect(getAssistantDisplayLabel({ role: "assistant" } as Message)).toBe("AGENT");
  });
});

describe("normalizeMessagesForDisplay", () => {
  it("returns messages unchanged for non-cursor agents", () => {
    const messages = [{ role: "user", content: "hi" } as Message];
    expect(normalizeMessagesForDisplay(messages, "claudecode")).toBe(messages);
  });
});
