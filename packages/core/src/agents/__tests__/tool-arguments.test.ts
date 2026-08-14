import { describe, expect, it } from "vitest";
import { normalizeToolArguments } from "../tool-arguments.js";

describe("normalizeToolArguments", () => {
  it("parses JSON objects, arrays, and scalars", () => {
    expect(normalizeToolArguments('{"path":"src/index.ts"}')).toEqual({ path: "src/index.ts" });
    expect(normalizeToolArguments('["a", 1]')).toEqual(["a", 1]);
    expect(normalizeToolArguments("42")).toBe(42);
  });

  it("preserves invalid and empty JSON strings", () => {
    expect(normalizeToolArguments("{invalid")).toBe("{invalid");
    expect(normalizeToolArguments("")).toBe("");
  });

  it("returns non-string values unchanged", () => {
    const value = { path: "src/index.ts" };

    expect(normalizeToolArguments(value)).toBe(value);
    expect(normalizeToolArguments(null)).toBeNull();
    expect(normalizeToolArguments(42)).toBe(42);
  });
});
