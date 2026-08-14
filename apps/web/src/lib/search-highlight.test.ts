import { describe, expect, it } from "vitest";
import { buildHighlightPattern } from "./search-highlight";

function matches(query: string | undefined, text: string): string[] {
  const pattern = buildHighlightPattern(query);
  return pattern ? Array.from(text.matchAll(pattern), (match) => match[0]) : [];
}

describe("buildHighlightPattern", () => {
  it("returns null for empty queries", () => {
    expect(buildHighlightPattern()).toBeNull();
    expect(buildHighlightPattern("   ")).toBeNull();
    expect(buildHighlightPattern("OR or")).toBeNull();
  });

  it("keeps quoted phrases together and ignores OR operators", () => {
    expect(matches('"quick brown" OR fox', "The quick brown fox")).toEqual(["quick brown", "fox"]);
  });

  it("matches terms case-insensitively", () => {
    expect(matches("alpha", "ALPHA alpha")).toEqual(["ALPHA", "alpha"]);
  });

  it("treats regex metacharacters as literal query text", () => {
    expect(matches("a+b? [test]", "a+b? [test] aXb test")).toEqual(["a+b?", "[test]"]);
  });
});
