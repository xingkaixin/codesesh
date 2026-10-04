import { describe, expect, it } from "vitest";
import { curveAt, resampleCurve, SAMPLES } from "./curve";

describe("resampleCurve", () => {
  it("puts the first and last value half a column inside the plot", () => {
    const curve = resampleCurve([0, 10]);

    // The ends are flat: everything before the first column centre reads as the
    // first value, so a peak lines up with the bar it belongs to.
    expect(curveAt(curve, 0)).toBeCloseTo(0, 5);
    expect(curveAt(curve, 0.25)).toBeCloseTo(0, 3);
    expect(curveAt(curve, 0.5)).toBeCloseTo(5, 1);
    expect(curveAt(curve, 0.75)).toBeCloseTo(10, 3);
    expect(curveAt(curve, 1)).toBeCloseTo(10, 5);
  });

  it("holds a single value flat across the plot", () => {
    const curve = resampleCurve([7]);

    expect(curveAt(curve, 0)).toBe(7);
    expect(curveAt(curve, 1)).toBe(7);
  });

  it("degrades to a flat zero without values", () => {
    const curve = resampleCurve([]);

    expect(curve).toHaveLength(SAMPLES);
    expect(curveAt(curve, 0.5)).toBe(0);
  });
});

describe("curveAt", () => {
  it("clamps a fraction outside the plot to its ends", () => {
    const curve = resampleCurve([2, 8]);

    expect(curveAt(curve, -1)).toBeCloseTo(2, 5);
    expect(curveAt(curve, 5)).toBeCloseTo(8, 5);
  });
});
