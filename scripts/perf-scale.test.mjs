import { describe, expect, it } from "vitest";
import { CASES, MAX_COST_GROWTH, checkGrowth } from "./perf-scale.mjs";

/** The pre-CS-145 allocator: every collision restarts its probe from 2. */
function quadraticAllocation(size) {
  const used = new Set();
  for (let index = 0; index < size; index += 1) {
    const base = "Same title #deadbeef";
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(path);
  }
}

function linearWork(size) {
  let total = 0;
  for (let index = 0; index < size; index += 1) total += index % 7;
  return total;
}

describe("CS-154: growth-rate gate", () => {
  // Small enough that the quadratic case below stays quick.
  const VERIFY_SIZES = [400, 1_600];

  it("passes work whose per-item cost stays flat", () => {
    const result = checkGrowth("linear", linearWork, VERIFY_SIZES);

    expect(result.ok).toBe(true);
    expect(result.sizes).toEqual(VERIFY_SIZES);
  });

  // Without this, the gate would be decoration.
  it("fails work that grows quadratically", () => {
    const result = checkGrowth("quadratic", quadraticAllocation, VERIFY_SIZES);

    expect(result.ok).toBe(false);
    expect(result.growth).toBeGreaterThan(MAX_COST_GROWTH);
  });

  it.each(CASES)("keeps %s linear", (_name, run) => {
    expect(checkGrowth(_name, run).ok).toBe(true);
  });
});
