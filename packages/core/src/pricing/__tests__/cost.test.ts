import { describe, expect, it } from "vitest";
import {
  applyMessageCost,
  applyMessageCosts,
  estimateCostForTokens,
  withEstimatedSessionCost,
} from "../cost.js";
import { pricingResolver } from "../resolver.js";
import type { Message, SessionStats } from "../../types/index.js";

describe("pricing", () => {
  it("estimates cache token cost from the registry", () => {
    const estimate = estimateCostForTokens("claude-sonnet-4-6", {
      input: 1300,
      output: 200,
      cache_create: 100,
      cache_read: 200,
    });

    expect(estimate?.source).toBe("estimated");
    expect(estimate?.cost).toBeCloseTo(0.006735);
  });

  it("resolves kimi-for-coding through the global alias table", () => {
    const estimate = estimateCostForTokens("kimi-for-coding", {
      input: 1000,
      output: 1000,
    });

    expect(estimate?.cost).toBeCloseTo(0.0031);
  });

  it("returns null for unknown models", () => {
    expect(estimateCostForTokens("unknown-model", { input: 1000, output: 1000 })).toBeNull();
    expect(pricingResolver.resolve("unknown-model")).toBeNull();
  });

  it("marks existing message costs as recorded", () => {
    const message = {
      id: "m1",
      role: "assistant",
      agent: "codex",
      time_created: 1000,
      mode: null,
      model: "gpt-5.5",
      provider: null,
      tokens: { input: 1000, output: 1000 },
      cost: 1,
      parts: [],
    } as Message;

    applyMessageCost(message);

    expect(message.cost).toBe(1);
    expect(message.cost_source).toBe("recorded");
  });

  it("estimates and aggregates message costs", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        agent: "codex",
        time_created: 1000,
        mode: null,
        model: "gpt-5.5",
        provider: null,
        tokens: { input: 1000, output: 1000, web_search_requests: 1 },
        parts: [],
      },
      {
        id: "m2",
        role: "assistant",
        agent: "codex",
        time_created: 1000,
        mode: null,
        model: "unknown-model",
        provider: null,
        tokens: { input: 1000, output: 1000 },
        cost: 0,
        parts: [],
      },
      {
        id: "m3",
        role: "assistant",
        agent: "codex",
        time_created: 1000,
        mode: null,
        model: "gpt-5.5",
        provider: null,
        tokens: { input: 1000, output: 0 },
        cost: 0.5,
        parts: [],
      },
    ] as Message[];

    const result = applyMessageCosts(messages);

    expect(messages[0]?.cost_source).toBe("estimated");
    expect(messages[1]?.cost_source).toBeUndefined();
    expect(messages[2]?.cost_source).toBe("recorded");
    expect(result.source).toBe("estimated");
    expect(result.totalCost).toBeGreaterThan(0.5);
  });

  it("keeps recorded session costs and estimates missing session costs", () => {
    const recorded: SessionStats = {
      message_count: 1,
      total_input_tokens: 1000,
      total_output_tokens: 1000,
      total_cost: 2,
    };
    const missing: SessionStats = {
      message_count: 1,
      total_input_tokens: 1000,
      total_output_tokens: 1000,
      total_cache_read_tokens: 200,
      total_cache_create_tokens: 100,
      total_cost: 0,
    };

    expect(withEstimatedSessionCost(recorded, "gpt-5.5")).toEqual({
      ...recorded,
      cost_source: "recorded",
    });
    expect(withEstimatedSessionCost(missing, "gpt-5.5")).toMatchObject({
      total_cost: expect.any(Number),
      cost_source: "estimated",
    });
    expect(withEstimatedSessionCost(missing, "unknown-model")).toBe(missing);
  });
});
