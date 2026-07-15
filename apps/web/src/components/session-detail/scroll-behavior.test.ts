import { describe, expect, it } from "vitest";
import { getActivationScrollBehavior, resolveReducedMotionScrollBehavior } from "./scroll-behavior";

describe("getActivationScrollBehavior", () => {
  it("uses immediate scrolling for keyboard activation", () => {
    expect(getActivationScrollBehavior(0)).toBe("auto");
  });

  it("uses smooth scrolling for pointer activation", () => {
    expect(getActivationScrollBehavior(1)).toBe("smooth");
  });
});

describe("resolveReducedMotionScrollBehavior", () => {
  it("removes smooth scrolling when reduced motion is enabled", () => {
    expect(resolveReducedMotionScrollBehavior("smooth", true)).toBe("auto");
  });

  it("preserves the requested behavior otherwise", () => {
    expect(resolveReducedMotionScrollBehavior("smooth", false)).toBe("smooth");
    expect(resolveReducedMotionScrollBehavior("auto", true)).toBe("auto");
  });
});
