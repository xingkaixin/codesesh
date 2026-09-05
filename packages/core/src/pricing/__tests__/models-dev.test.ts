import { describe, expect, it } from "vitest";
import { parseModelsDevPricing } from "../models-dev.js";

const model = (input: number, output = 15) => ({ cost: { input, output } });

describe("models.dev pricing", () => {
  it("converts dollars per million tokens and cache prices into per-token prices", () => {
    const prices = parseModelsDevPricing({
      anthropic: {
        models: {
          "claude-new": {
            cost: {
              input: 3,
              output: 15,
              cache_write: 3.75,
              cache_read: 0.3,
            },
          },
        },
      },
    });
    expect(prices.get("claude-new")).toEqual({
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheCreateCostPerToken: 0.00000375,
      cacheReadCostPerToken: 0.0000003,
      reasoningCostPerToken: 0.000015,
      webSearchCostPerRequest: 0.01,
    });
  });

  it("prefers original providers for bare names and preserves explicit provider prices", () => {
    const data = {
      "aaa-reseller": { models: { "gpt-new": model(9), "openai/gpt-new": model(8) } },
      openai: { models: { "gpt-new": model(2) } },
      openrouter: { models: { "openai/gpt-new": model(4) } },
    };
    const prices = parseModelsDevPricing(data);
    expect(prices.get("gpt-new")?.inputCostPerToken).toBe(0.000002);
    expect(prices.get("openai/gpt-new")?.inputCostPerToken).toBe(0.000002);
    expect(prices.get("openrouter/openai/gpt-new")?.inputCostPerToken).toBe(0.000004);
    expect(parseModelsDevPricing(Object.fromEntries(Object.entries(data).reverse()))).toEqual(
      prices,
    );
  });

  it("ignores malformed entries while preserving zero and missing cache prices", () => {
    const prices = parseModelsDevPricing({
      broken: null,
      test: {
        models: {
          broken: null,
          missing: {},
          invalid: model(-1),
          infinite: model(Infinity),
          free: model(0, 0),
          normal: model(2),
        },
      },
    });
    expect([...prices.keys()].sort()).toEqual(["free", "normal", "test/free", "test/normal"]);
    expect(prices.get("free")?.inputCostPerToken).toBe(0);
    expect(prices.get("normal")?.cacheReadCostPerToken).toBe(0.000002);
    expect(parseModelsDevPricing(null).size).toBe(0);
  });
});
