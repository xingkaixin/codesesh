import { describe, expect, it } from "vitest";
import { buildSemanticOutputContent } from "./tool-normalize";

describe("buildSemanticOutputContent", () => {
  it("does not load remote image URLs from historical output", () => {
    expect(
      buildSemanticOutputContent([{ type: "image", url: "https://tracker.example/tool.png" }]),
    ).toBeNull();
  });
});
