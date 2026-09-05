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

  it("matches the longest billable boundary prefix regardless of registry order", () => {
    const registry = getPricingRegistry();
    const original = new Map(registry);
    const billable = original.get("claude-opus-4-6")!;
    const entries = Array.from(
      { length: 100 },
      (_, index) => [`test-model-${index}`, { ...billable, inputCostPerToken: index + 1 }] as const,
    );
    const free = {
      ...billable,
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheCreateCostPerToken: 0,
      cacheReadCostPerToken: 0,
    };
    try {
      for (const ordered of [entries, [...entries].reverse()]) {
        registry.clear();
        for (const [name, price] of ordered) registry.set(name, price);
        registry.set("test-model-7-extended", free);
        for (const model of [
          ...entries.map(([name]) => `${name}-thinking-high`),
          "test-model-7-extended-thinking",
          "test-model-700x",
          "missing-model",
        ]) {
          const expected =
            [...registry]
              .filter(([key, price]) => price.inputCostPerToken > 0 && model.startsWith(`${key}-`))
              .sort(([a], [b]) => b.length - a.length)[0]?.[1] ?? null;
          expect(pricingResolver.resolve(model), model).toBe(expected);
        }
      }
    } finally {
      registry.clear();
      for (const [name, price] of original) registry.set(name, price);
    }
  });

  it("uses changed prices and newly available models immediately", () => {
    const registry = getPricingRegistry();
    const name = "test-newly-priced-model";
    const price = registry.get("claude-opus-4-6")!;
    try {
      expect(pricingResolver.resolve(`${name}-thinking`)).toBeNull();
      registry.set(name, price);
      expect(pricingResolver.resolve(`${name}-thinking`)).toBe(price);
      const updated = { ...price, inputCostPerToken: 1 };
      registry.set(name, updated);
      expect(pricingResolver.resolve(`${name}-thinking`)).toBe(updated);
      registry.delete(name);
      expect(pricingResolver.resolve(`${name}-thinking`)).toBeNull();
    } finally {
      registry.delete(name);
    }
  });

  it("rejects unknown model names", () => {
    expect(pricingResolver.resolve("vendor/nonexistent-model")).toBeNull();
  });
});
