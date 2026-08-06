import { describe, expect, it } from "vitest";
import { type DiffTone, diffToneClass } from "./diff-tone";

const TONES: DiffTone[] = ["add", "remove", "hunk", "meta", "header", "context"];

describe("diffToneClass", () => {
  it("resolves every tone through theme tokens only", () => {
    for (const tone of TONES) {
      const className = diffToneClass(tone);
      expect(className).toMatch(/var\(--/);
      expect(className).not.toMatch(/#[0-9a-fA-F]{3}/);
      expect(className).not.toContain("dark:");
    }
  });

  it("gives each tone a distinct class", () => {
    expect(new Set(TONES.map(diffToneClass)).size).toBe(TONES.length);
  });
});
