import { describe, expect, it } from "vitest";
import { getPricingRegistry } from "../fetcher.js";
import { pricingResolver } from "../resolver.js";

describe("pricing resolver", () => {
  it("normalizes provider prefixes, underscores, and dated versions", () => {
    const expected = getPricingRegistry().get("claude-sonnet-4-6");

    expect(pricingResolver.resolve("Anthropic/Claude_Sonnet_4_6@2026-07-17")).toEqual(expected);
  });

  it("uses the longest billable model prefix for fuzzy variants", () => {
    const expected = getPricingRegistry().get("claude-opus-4-6");

    expect(pricingResolver.resolve("claude-opus-4-6-thinking")).toEqual(expected);
  });

  it("rejects unknown model names", () => {
    expect(pricingResolver.resolve("vendor/nonexistent-model")).toBeNull();
  });
});
