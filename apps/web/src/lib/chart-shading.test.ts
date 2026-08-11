import { describe, expect, it } from "vitest";
import { hashUnit, niceMax, resolveColor, tileWave, withAlpha } from "./chart-shading";

describe("niceMax", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [0.7, 1],
    [1.2, 2],
    [4.9, 5],
    [6, 10],
    [12_345, 20_000],
  ])("rounds %s up to %s", (raw, expected) => {
    expect(niceMax(raw)).toBe(expected);
  });
});

describe("tileWave", () => {
  it("stays inside the unit range and moves with the drift", () => {
    const still = tileWave(12, 34, 0);
    const drifted = tileWave(12, 34, 1.7);

    expect(still).toBeGreaterThanOrEqual(0);
    expect(still).toBeLessThanOrEqual(1);
    expect(drifted).not.toBeCloseTo(still, 3);
  });
});

describe("hashUnit", () => {
  it("is deterministic per coordinate", () => {
    expect(hashUnit(3, 9)).toBe(hashUnit(3, 9));
    expect(hashUnit(3, 9)).not.toBe(hashUnit(9, 3));
    expect(hashUnit(3, 9)).toBeLessThan(1);
    expect(hashUnit(3, 9)).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveColor", () => {
  const style = {
    getPropertyValue: (name: string) => (name === "--chart-1" ? " #4a9eff " : ""),
  } as CSSStyleDeclaration;

  it("reads a custom property through", () => {
    expect(resolveColor(style, "var(--chart-1)")).toBe("#4a9eff");
  });

  it("keeps literals and unknown properties usable", () => {
    expect(resolveColor(style, "#fff")).toBe("#fff");
    expect(resolveColor(style, "var(--missing)")).toBe("var(--missing)");
  });
});

describe("withAlpha", () => {
  it.each([
    ["#4a9eff", "rgba(74, 158, 255, 0.5)"],
    ["#abc", "rgba(170, 187, 204, 0.5)"],
  ])("expands %s", (color, expected) => {
    expect(withAlpha(color, 0.5)).toBe(expected);
  });

  it("leaves a non-hex colour alone", () => {
    expect(withAlpha("rebeccapurple", 0.5)).toBe("rebeccapurple");
  });
});
