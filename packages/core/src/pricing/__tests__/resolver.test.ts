import { describe, expect, it } from "vitest";
import { getPricingRegistry } from "../fetcher.js";
import { pricingResolver } from "../resolver.js";

describe("pricing resolver", () => {
  it("normalizes provider prefixes, underscores, and dated versions", () => {
    const expected = getPricingRegistry().get("claude-sonnet-4-6");

    expect(pricingResolver.resolve("Anthropic/Claude_Sonnet_4_6@2026-07-17")).toEqual(expected);
  });

  it("uses the longest billable model prefix for fuzzy variants", () => {
    const registry = getPricingRegistry();
    const expected = registry.get("claude-opus-4-6")!;
    registry.set("test-fuzzy-model", { ...expected, inputCostPerToken: 1 });
    registry.set("test-fuzzy-model-extended", expected);
    try {
      expect(pricingResolver.resolve("test-fuzzy-model-extended-thinking")).toEqual(expected);
    } finally {
      registry.delete("test-fuzzy-model");
      registry.delete("test-fuzzy-model-extended");
    }
  });

  it("prefers exact model prices over legacy aliases and stripped dates", () => {
    const registry = getPricingRegistry();
    const names = ["gpt-5-codex", "claude-sonnet-4-6-20260905"];
    const pricing = { ...registry.get("claude-sonnet-4-6")!, inputCostPerToken: 0.000123 };
    for (const name of names) {
      const previous = registry.get(name);
      try {
        registry.set(name, pricing);
        expect(pricingResolver.resolve(name)).toEqual(pricing);
      } finally {
        if (previous) registry.set(name, previous);
        else registry.delete(name);
      }
    }
  });

  it("rejects unknown model names", () => {
    expect(pricingResolver.resolve("vendor/nonexistent-model")).toBeNull();
  });
});
