import { describe, expect, it } from "vitest";
import { TranscriptBuilder } from "../transcript-builder.js";

describe("TranscriptBuilder", () => {
  it("groups streaming assistant parts until a tool closes the text message", () => {
    const builder = new TranscriptBuilder();
    const meta = { id: "assistant", timestampMs: 10, agent: "codex" };

    builder.appendAssistantPart({ type: "reasoning", text: "think" }, meta);
    builder.appendAssistantPart({ type: "text", text: "answer" }, meta);
    builder.appendToolCall(
      { type: "tool", tool: "read", callID: "call-1", state: { input: { path: "a.ts" } } },
      meta,
      { markModeAsTool: true },
    );
    builder.appendAssistantPart({ type: "text", text: "after tool" }, meta);

    const result = builder.finish();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      mode: "tool",
      parts: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "answer" },
        { type: "tool", callID: "call-1" },
      ],
    });
    expect(result.messages[1]?.parts).toEqual([{ type: "text", text: "after tool" }]);
  });

  it("preserves message defaults and only deduplicates when requested", () => {
    const builder = new TranscriptBuilder();
    const meta = { id: "assistant", timestampMs: 10 };

    builder.appendAssistantPart({ type: "text", text: "same" }, meta);
    builder.appendAssistantPart({ type: "text", text: "same" }, meta);
    builder.appendAssistantPart({ type: "text", text: "same" }, meta, {
      deduplicateTail: true,
    });

    expect(builder.finish().messages[0]).toEqual({
      id: "assistant",
      role: "assistant",
      agent: null,
      time_created: 10,
      mode: null,
      model: null,
      provider: null,
      tokens: undefined,
      cost: 0,
      cost_source: undefined,
      parts: [
        { type: "text", text: "same" },
        { type: "text", text: "same" },
      ],
      subagent_id: undefined,
      nickname: undefined,
    });
  });

  it("supports sparse message fields for adapters that omit defaults", () => {
    const builder = new TranscriptBuilder({ messageDefaults: "sparse" });
    builder.appendMessage({
      id: "user",
      role: "user",
      timestampMs: 10,
      parts: [{ type: "text", text: "visible" }],
    });

    expect(JSON.stringify(builder.finish().messages[0])).toBe(
      '{"id":"user","role":"user","time_created":10,"parts":[{"type":"text","text":"visible"}]}',
    );
  });

  it("resolves tool calls without exposing message indexes", () => {
    const builder = new TranscriptBuilder();
    builder.appendMessage({
      id: "assistant",
      role: "assistant",
      timestampMs: 10,
      parts: [{ type: "tool", tool: "read", callID: "call-1", state: {} }],
    });

    expect(
      builder.resolveToolCall("call-1", {
        output: [{ type: "text", text: "done" }],
        status: "completed",
        consume: true,
      }),
    ).toBe(true);
    expect(builder.resolveToolCall("call-1", { status: "error" })).toBe(false);
    expect(builder.finish().messages[0]?.parts[0]?.state).toEqual({
      output: [{ type: "text", text: "done" }],
      status: "completed",
    });
  });

  it("supports turn-based grouping and explicit tool targets", () => {
    const builder = new TranscriptBuilder();
    const meta = { id: "assistant", timestampMs: 10, agent: "kimi" };

    builder.appendAssistantPart({ type: "text", text: "before" }, meta, {
      grouping: "current",
    });
    builder.appendToolCall({ type: "tool", tool: "read", callID: "call-1", state: {} }, meta, {
      target: "current",
    });
    builder.appendAssistantPart({ type: "reasoning", text: "after" }, meta, {
      grouping: "current",
    });

    expect(builder.finish().messages).toEqual([
      expect.objectContaining({
        parts: [
          { type: "text", text: "before" },
          { type: "tool", tool: "read", callID: "call-1", state: {} },
          { type: "reasoning", text: "after" },
        ],
      }),
    ]);
  });

  it("can clear a stale text target when reasoning opens a new message", () => {
    const builder = new TranscriptBuilder();
    const meta = { id: "assistant", timestampMs: 10, agent: "codex" };

    builder.appendAssistantPart({ type: "text", text: "answer" }, meta);
    builder.appendAssistantPart({ type: "reasoning", text: "next thought" }, meta, {
      resetLatestText: true,
    });
    builder.appendToolCall({ type: "tool", tool: "read", callID: "call-1", state: {} }, meta);

    const messages = builder.finish().messages;
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "answer" }]);
    expect(messages[1]?.parts).toEqual([
      { type: "reasoning", text: "next thought" },
      { type: "tool", tool: "read", callID: "call-1", state: {} },
    ]);
  });

  it("derives stats after cleaning and preserves external stats baselines", () => {
    const builder = new TranscriptBuilder();
    builder.appendMessage({
      id: "empty",
      role: "user",
      timestampMs: 1,
      parts: [{ type: "text", text: "<command-name>clear</command-name>" }],
    });
    builder.appendMessage({
      id: "assistant",
      role: "assistant",
      timestampMs: 2,
      model: "model",
      tokens: { input: 10, output: 5, cache_read: 3 },
      cost: 0.2,
      costSource: "estimated",
      parts: [{ type: "text", text: "visible" }],
    });

    expect(
      builder.finish({
        message_count: 0,
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cost: 0.1,
      }),
    ).toEqual({
      messages: [expect.objectContaining({ id: "assistant" })],
      stats: {
        message_count: 1,
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cache_read_tokens: 3,
        total_cost: 0.1,
        cost_source: undefined,
      },
    });
  });
});
