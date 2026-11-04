import { describe, expect, it } from "vitest";
import { buildHighlightPattern } from "./search-highlight";

function matches(query: string | undefined, text: string): string[] {
  const pattern = buildHighlightPattern(query);
  return pattern ? Array.from(text.matchAll(pattern), (match) => match[0]) : [];
}

describe("buildHighlightPattern", () => {
  it("treats regex metacharacters as literal query text", () => {
    expect(matches("a+b? [test]", "a+b? [test] aXb test")).toEqual(["a+b?", "[test]"]);
  });
});
