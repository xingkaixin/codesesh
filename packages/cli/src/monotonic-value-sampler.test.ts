import { describe, expect, it, vi } from "vitest";
import { MonotonicValueSampler } from "./monotonic-value-sampler.js";

describe("MonotonicValueSampler", () => {
  it("coalesces a zero-duration burst and flushes its latest value", () => {
    const emit = vi.fn();
    const sampler = new MonotonicValueSampler<number>(100, emit, () => 0);

    for (let value = 1; value <= 10_000; value += 1) sampler.push(value, "scanning");
    sampler.flush();

    expect(emit.mock.calls.flat()).toEqual([1, 10_000]);
  });

  it("samples a long synchronous loop by monotonic elapsed time", () => {
    let now = 0;
    const emit = vi.fn();
    const sampler = new MonotonicValueSampler<number>(100, emit, () => now);

    for (let value = 1; value <= 10_000; value += 1) {
      sampler.push(value, "scanning");
      now += 1;
    }
    sampler.flush();

    expect(emit).toHaveBeenCalledTimes(101);
    expect(emit).toHaveBeenLastCalledWith(10_000);
  });

  it("flushes the previous phase before its transition", () => {
    const values: string[] = [];
    const sampler = new MonotonicValueSampler<string>(
      100,
      (value) => values.push(value),
      () => 0,
    );
    sampler.push("scan 1", "scanning");
    sampler.push("scan 2", "scanning");
    sampler.push("finalize 1", "finalizing");

    expect(values).toEqual(["scan 1", "scan 2", "finalize 1"]);
  });
});
