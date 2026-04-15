import { describe, it, expect } from "vitest";
import { normalizeTitleText, basenameTitle, resolveSessionTitle } from "../title-fallback.js";

describe("normalizeTitleText", () => {
  it("returns null for empty string", () => {
    expect(normalizeTitleText("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeTitleText("   \t\n  ")).toBeNull();
  });

  it("trims and collapses whitespace", () => {
    expect(normalizeTitleText("  hello   world  ")).toBe("hello world");
  });

  it("returns text as-is when within limit", () => {
    expect(normalizeTitleText("Hello World")).toBe("Hello World");
  });

  it("truncates to 100 characters", () => {
    const long = "a".repeat(200);
    const result = normalizeTitleText(long);
    expect(result).toBe("a".repeat(100));
  });

  it("returns exactly 100 chars at the boundary", () => {
    const exact = "a".repeat(100);
    expect(normalizeTitleText(exact)).toBe(exact);
    expect(normalizeTitleText(exact)!.length).toBe(100);
  });
});

describe("basenameTitle", () => {
  it("returns null for null", () => {
    expect(basenameTitle(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(basenameTitle(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(basenameTitle("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(basenameTitle("   ")).toBeNull();
  });

  it("returns null for slashes only", () => {
    expect(basenameTitle("///")).toBeNull();
  });

  it("extracts basename from a path", () => {
    expect(basenameTitle("/home/user/project")).toBe("project");
  });

  it("strips trailing slashes", () => {
    expect(basenameTitle("/home/user/project/")).toBe("project");
  });

  it("handles path with only filename", () => {
    expect(basenameTitle("project")).toBe("project");
  });
});

describe("resolveSessionTitle", () => {
  it("returns explicit title when provided", () => {
    expect(resolveSessionTitle("My Session", null, null)).toBe("My Session");
  });

  it("falls back to message when explicit is null", () => {
    expect(resolveSessionTitle(null, "Hello", null)).toBe("Hello");
  });

  it("falls back to directory when explicit and message are null", () => {
    expect(resolveSessionTitle(null, null, "/home/project")).toBe("/home/project");
  });

  it("returns 'Untitled Session' when all are null", () => {
    expect(resolveSessionTitle(null, null, null)).toBe("Untitled Session");
  });

  it("returns 'Untitled Session' when all are empty strings", () => {
    expect(resolveSessionTitle("", "", "")).toBe("Untitled Session");
  });

  it("prioritizes explicit over message", () => {
    expect(resolveSessionTitle("First", "Second", "Third")).toBe("First");
  });

  it("normalizes whitespace in chosen candidate", () => {
    expect(resolveSessionTitle("  spaced  out  ", null, null)).toBe("spaced out");
  });
});
