import { describe, expect, it } from "vitest";
import { buildTextRenderPreview, growContentRenderBudget } from "./content-render-budget";

describe("content render budget", () => {
  it("limits text by characters", () => {
    expect(buildTextRenderPreview("abcdefgh", { maxCharacters: 5, maxLines: 10 })).toEqual({
      text: "abcde",
      renderedCharacters: 5,
      renderedLines: 1,
      truncated: true,
    });
  });

  it("limits text by complete lines", () => {
    expect(buildTextRenderPreview("one\ntwo\nthree", { maxCharacters: 100, maxLines: 2 })).toEqual({
      text: "one\ntwo",
      renderedCharacters: 7,
      renderedLines: 2,
      truncated: true,
    });
  });

  it("does not leave a dangling carriage return or surrogate", () => {
    expect(buildTextRenderPreview("line\r\nnext", { maxCharacters: 5, maxLines: 10 }).text).toBe(
      "line",
    );
    expect(buildTextRenderPreview("abc😀tail", { maxCharacters: 4, maxLines: 10 }).text).toBe(
      "abc",
    );
  });

  it("doubles each budget without exceeding the source", () => {
    const grown = growContentRenderBudget({ maxCharacters: 5, maxLines: 3 }, 17, 9);

    expect(grown).toEqual({ maxCharacters: 10, maxLines: 6 });
    expect(growContentRenderBudget(grown, 17, 9)).toEqual({
      maxCharacters: 17,
      maxLines: 9,
    });
  });
});
