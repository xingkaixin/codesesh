import { describe, expect, it } from "vitest";
import { CodexTokenUsageAccumulator } from "../codex-token-usage.js";

function tokenPayload(
  lastUsage: Record<string, number> | undefined,
  totalUsage?: Record<string, number>,
): Record<string, unknown> {
  return {
    info: {
      last_token_usage: lastUsage,
      total_token_usage: totalUsage,
    },
  };
}

describe("CodexTokenUsageAccumulator", () => {
  it("deduplicates events by their positive cumulative total", () => {
    const accumulator = new CodexTokenUsageAccumulator();
    const payload = tokenPayload(
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    );

    expect(accumulator.consume(payload, "gpt-5.5")).not.toBeNull();
    expect(accumulator.consume(payload, "gpt-5.5")).toBeNull();
    expect(accumulator.stats()).toMatchObject({
      total_input_tokens: 100,
      total_output_tokens: 20,
    });
    expect(accumulator.modelUsage()).toEqual({ "gpt-5.5": 120 });
  });

  it("counts last usage when a cumulative usage record is absent", () => {
    const accumulator = new CodexTokenUsageAccumulator();

    accumulator.consume(tokenPayload({ input_tokens: 40, output_tokens: 10 }), "gpt-5.5");
    accumulator.consume(tokenPayload({ input_tokens: 20, output_tokens: 5 }), "gpt-5.5");

    expect(accumulator.stats()).toMatchObject({
      total_input_tokens: 60,
      total_output_tokens: 15,
    });
    expect(accumulator.modelUsage()).toEqual({ "gpt-5.5": 75 });
  });

  it("keeps cumulative baselines current when records switch away from last usage", () => {
    const accumulator = new CodexTokenUsageAccumulator();

    accumulator.consume(
      tokenPayload(
        { input_tokens: 100, output_tokens: 20 },
        { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      ),
      "gpt-5.5",
    );
    accumulator.consume(
      tokenPayload(undefined, {
        input_tokens: 140,
        output_tokens: 30,
        total_tokens: 170,
      }),
      "gpt-5.5",
    );

    expect(accumulator.stats()).toMatchObject({
      total_input_tokens: 140,
      total_output_tokens: 30,
    });
    expect(accumulator.modelUsage()).toEqual({ "gpt-5.5": 170 });
  });

  it("preserves cache-only usage deltas", () => {
    const accumulator = new CodexTokenUsageAccumulator();

    const delta = accumulator.consume(
      tokenPayload({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 10 }),
      "gpt-5.5",
    );

    expect(delta?.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: undefined,
      cache_read: 10,
    });
    expect(accumulator.stats().total_cache_read_tokens).toBe(10);
  });
});
