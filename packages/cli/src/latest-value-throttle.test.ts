import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestValueThrottle } from "./latest-value-throttle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("LatestValueThrottle", () => {
  it("bounds a burst and emits its latest value at the trailing edge", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const throttle = new LatestValueThrottle<number>(100, emit);

    for (let value = 1; value <= 10_000; value += 1) throttle.push(value, "scanning");

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(10_000);
  });

  it("flushes the previous phase before emitting a transition", () => {
    vi.useFakeTimers();
    const values: string[] = [];
    const throttle = new LatestValueThrottle<string>(100, (value) => values.push(value));

    throttle.push("scan 1", "scanning");
    throttle.push("scan 2", "scanning");
    throttle.push("finalize 1", "finalizing");

    expect(values).toEqual(["scan 1", "scan 2", "finalize 1"]);
  });

  it("flushes completion and drops cancelled work", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const throttle = new LatestValueThrottle<number>(100, emit);
    throttle.push(1, "scanning");
    throttle.push(2, "scanning");
    throttle.flush();
    throttle.push(3, "scanning");
    throttle.push(4, "scanning");
    throttle.cancel();

    await vi.runAllTimersAsync();

    expect(emit.mock.calls.flat()).toEqual([1, 2, 3]);
  });
});
