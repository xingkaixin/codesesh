import { describe, expect, it } from "vitest";
import { MAX_COST_GROWTH, evaluateGrowth } from "./perf-scale.mjs";

describe("CS-154: growth-rate gate", () => {
  const VERIFY_SIZES = [400, 1_600];

  it("passes measurements whose per-item cost stays flat", () => {
    const result = evaluateGrowth("linear", VERIFY_SIZES, [4, 16]);

    expect(result.ok).toBe(true);
    expect(result.sizes).toEqual(VERIFY_SIZES);
    expect(result.growth).toBe(1);
  });

  it("fails measurements whose per-item cost grows quadratically", () => {
    const result = evaluateGrowth("quadratic", VERIFY_SIZES, [16, 256]);

    expect(result.ok).toBe(false);
    expect(result.growth).toBeGreaterThan(MAX_COST_GROWTH);
  });
});
