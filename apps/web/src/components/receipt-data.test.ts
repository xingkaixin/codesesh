import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../lib/api";
import { createReceiptPayload } from "./receipt-data";

function session(): SessionDetail {
  return {
    reference: { agentName: "codex", sessionId: "receipt" },
    title: "Receipt",
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: 3,
      total_input_tokens: 1500,
      total_output_tokens: 250,
      total_cache_read_tokens: 400,
      total_cache_create_tokens: 100,
      total_cost: 0.012,
      cost_source: "estimated",
    },
    messages: [
      { id: "u", role: "user", time_created: 1, parts: [{ type: "text", text: "Hello" }] },
      {
        id: "a",
        role: "assistant",
        time_created: 2,
        model: "model-a",
        provider: "provider-a",
        tokens: { input: 1000, output: 100, reasoning: 50, cache_read: 400, cache_create: 100 },
        cost: 0.007,
        cost_source: "estimated",
        cost_breakdown: { input: 0.001, output: 0.003, cache_read: 0.001, cache_create: 0.002 },
        parts: [{ type: "tool", tool: "read", state: { status: "completed", input: {} } }],
      },
      {
        id: "b",
        role: "assistant",
        time_created: 3,
        model: "model-b",
        provider: "provider-b",
        tokens: { input: 500, output: 100 },
        cost: 0.005,
        cost_source: "estimated",
        cost_breakdown: { input: 0.002, output: 0.003, cache_read: 0, cache_create: 0 },
        parts: [],
      },
    ],
  };
}

describe("session receipt", () => {
  it("omits unknown models without usage or cost while retaining activity counts", () => {
    const value = session();
    value.messages[0]!.cost = 0;
    value.messages.push({
      id: "empty",
      role: "assistant",
      time_created: 4,
      tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
      cost: 0,
      parts: [],
    });
    const result = createReceiptPayload(value);
    expect(result.models.map((model) => model.name)).toEqual(["model-a", "model-b"]);
    expect(result.items.map((item) => item.count)).toEqual([1, 3, 1]);
    expect(result.rows.map((row) => row.cost)).toEqual([0.003, 0.006, 0.001, 0.002]);
  });

  it.each([{ tokens: { cache_read: 10 } }, { tokens: { reasoning: 10 } }, { cost: 0.01 }])(
    "retains unknown models with actual usage or cost: %j",
    (usage) => {
      const value = session();
      Object.assign(value.messages[0]!, usage);
      const result = createReceiptPayload(value);
      expect(result.models).toHaveLength(3);
      expect(
        result.models[0]?.rows.some((row) => (row.tokens ?? 0) > 0) ||
          result.models[0]?.cost === 0.01,
      ).toBe(true);
    },
  );

  it("separates models, cached input and output while counting each token once", () => {
    const result = createReceiptPayload(session());
    expect(result.items.map((item) => item.count)).toEqual([1, 2, 1]);
    expect(result.models.map((model) => model.name)).toEqual(["model-a", "model-b"]);
    expect(result.models[0]?.rows.map((row) => row.tokens)).toEqual([500, 150, 400, 100]);
    expect(result.rows.map((row) => row.tokens)).toEqual([1000, 250, 400, 100]);
    expect(result.rows.map((row) => row.cost)).toEqual([0.003, 0.006, 0.001, 0.002]);
    expect(result.totalTokens).toBe(1750);
  });

  it("shows zero cache writes in the total when every model reports none", () => {
    const value = session();
    delete value.stats.total_cache_create_tokens;
    value.messages[1]!.tokens!.cache_create = 0;
    expect(createReceiptPayload(value).rows[3]?.tokens).toBe(0);
  });

  it("keeps recorded totals without inventing price splits or merging providers", () => {
    const value = session();
    value.messages[2]!.model = "model-a";
    value.messages[2]!.cost_source = "recorded";
    delete value.messages[2]!.cost_breakdown;
    const result = createReceiptPayload(value);
    expect(result.models).toHaveLength(2);
    expect(result.models[1]?.cost).toBe(0.005);
    expect(result.models[1]?.rows.every((row) => row.cost === undefined)).toBe(true);
    expect(result.rows.every((row) => row.cost === undefined)).toBe(true);
    expect(result.totalCost).toBe(0.012);
  });

  it("preserves unallocated session usage and models with no message-level usage", () => {
    const value = session();
    value.model_usage = { "model-c": 90 };
    value.stats.total_tokens = 1840;
    value.stats.total_cost = 0.02;
    const result = createReceiptPayload(value);
    expect(result.models[2]?.rows.every((row) => row.tokens === undefined)).toBe(true);
    expect(result.totalTokens).toBe(1840);
    expect(result.rows.every((row) => row.cost === undefined)).toBe(true);
  });
  it("does not present unpriced usage as free", () => {
    const value = session();
    value.stats.total_cost = 0;
    delete value.stats.cost_source;
    for (const message of value.messages) {
      message.cost = 0;
      delete message.cost_source;
      delete message.cost_breakdown;
    }
    const result = createReceiptPayload(value);
    expect(result.totalCost).toBeUndefined();
    expect(result.models.every((model) => model.cost === undefined)).toBe(true);
  });
});
