import { describe, expect, it } from "vitest";
import { getPricingRegistry, hasBillablePricing } from "../fetcher.js";

describe("pricing fetcher", () => {
  it("loads the bundled registry with billable models", () => {
    const pricing = getPricingRegistry().get("claude-sonnet-4-6");

    expect(pricing).toBeDefined();
    expect(hasBillablePricing(pricing!)).toBe(true);
  });

  it("rejects entries whose billable dimensions are all zero", () => {
    expect(
      hasBillablePricing({
        inputCostPerToken: 0,
        outputCostPerToken: 0,
        cacheCreateCostPerToken: 0,
        cacheReadCostPerToken: 0,
        reasoningCostPerToken: 1,
        webSearchCostPerRequest: 1,
      }),
    ).toBe(false);
  });
});
