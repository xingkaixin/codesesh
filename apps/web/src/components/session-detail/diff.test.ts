import { describe, expect, it } from "vitest";
import {
  buildKimiEditDiffBlocks,
  buildStructuredDiffFromTexts,
  createDiffBlock,
  extractEditDiff,
  getDiffBlockLabel,
  getKimiEditEntries,
  splitDiffChunkLines,
} from "./diff";
import type { NormalizedToolState } from "./tool-normalize";

function state(overrides?: Partial<NormalizedToolState>): NormalizedToolState {
  return {
    status: "completed",
    inputValue: null,
    outputValue: null,
    errorValue: null,
    metadataValue: null,
    inputText: "",
    command: "",
    ...overrides,
  };
}

describe("getDiffBlockLabel", () => {
  it("returns filename for simple paths", () => {
    expect(getDiffBlockLabel("/abs/file.ts")).toBe("file.ts · /abs/file.ts");
  });

  it("returns edit for empty path", () => {
    expect(getDiffBlockLabel("")).toBe("edit");
  });
});

describe("splitDiffChunkLines", () => {
  it("splits by newline and drops trailing empty", () => {
    expect(splitDiffChunkLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitDiffChunkLines("a\\nb")).toEqual(["a", "b"]); // escaped newlines
  });
});

describe("createDiffBlock", () => {
  it("produces a unified-diff-like string", () => {
    const result = createDiffBlock("old", "new");
    expect(result).toContain("- old");
    expect(result).toContain("+ new");
    expect(result).toContain("@@");
  });
});

describe("buildStructuredDiffFromTexts", () => {
  it("returns empty for no content", () => {
    expect(buildStructuredDiffFromTexts("/f.ts", "", "")).toEqual([]);
  });

  it("produces diff blocks with add/remove lines", () => {
    const blocks = buildStructuredDiffFromTexts("/f.ts", "old line", "new line");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines.some((l) => l.type === "remove")).toBe(true);
    expect(blocks[0]!.lines.some((l) => l.type === "add")).toBe(true);
  });
});

describe("getKimiEditEntries", () => {
  it("returns array for single edit object", () => {
    expect(getKimiEditEntries({ edit: { old: "a", new: "b" } })).toHaveLength(1);
  });

  it("returns array for edit array", () => {
    expect(getKimiEditEntries({ edit: [{ old: "a" }, { old: "b" }] })).toHaveLength(2);
  });

  it("returns empty for no edit", () => {
    expect(getKimiEditEntries({})).toEqual([]);
  });
});

describe("buildKimiEditDiffBlocks", () => {
  it("builds diff blocks from kimi edit entries", () => {
    const blocks = buildKimiEditDiffBlocks(
      state({ inputValue: { edit: { old: "line1", new: "line2" } } }),
      "/file.ts",
    );
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe("extractEditDiff", () => {
  it("returns metadata diff when present", () => {
    expect(extractEditDiff(state({ metadataValue: { diff: "+ added\\n- removed" } }))).toBe(
      "+ added\n- removed",
    );
  });

  it("falls back to output when no diff", () => {
    expect(extractEditDiff(state({ outputValue: "some output" }))).toBe("some output");
  });
});
