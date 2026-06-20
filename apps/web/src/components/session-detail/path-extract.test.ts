import { describe, expect, it } from "vitest";
import {
  collectPathsFromValue,
  extractPathsFromToolInput,
  formatTrackedPath,
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
  looksLikeFilePath,
  shouldTreatAsPathKey,
} from "./path-extract";

describe("looksLikeFilePath", () => {
  it("accepts absolute paths", () => {
    expect(looksLikeFilePath("/home/user/file.ts")).toBe(true);
  });

  it("accepts relative paths", () => {
    expect(looksLikeFilePath("./src/index.ts")).toBe(true);
    expect(looksLikeFilePath("../parent/dir")).toBe(true);
  });

  it("rejects URLs", () => {
    expect(looksLikeFilePath("https://example.com")).toBe(false);
  });

  it("rejects multiline text", () => {
    expect(looksLikeFilePath("line1\nline2")).toBe(false);
  });

  it("rejects excessively long strings", () => {
    expect(looksLikeFilePath(`${"/path".repeat(100)}`)).toBe(false);
  });
});

describe("shouldTreatAsPathKey", () => {
  it("treats path/file keys as path keys", () => {
    expect(shouldTreatAsPathKey("path")).toBe(true);
    expect(shouldTreatAsPathKey("filePath")).toBe(true);
    expect(shouldTreatAsPathKey("file_path")).toBe(true);
  });

  it("rejects content/command keys", () => {
    expect(shouldTreatAsPathKey("command")).toBe(false);
    expect(shouldTreatAsPathKey("content")).toBe(false);
    expect(shouldTreatAsPathKey("cwd")).toBe(false);
  });
});

describe("collectPathsFromValue / extractPathsFromToolInput", () => {
  it("collects paths from nested objects under path keys", () => {
    const paths = new Set<string>();
    collectPathsFromValue({ filePath: "/abs/file.ts" }, "", paths);
    expect([...paths]).toEqual(["/abs/file.ts"]);
  });

  it("extractPathsFromToolInput returns array", () => {
    expect(extractPathsFromToolInput({ path: "/a.ts", other: { filePath: "/b.ts" } })).toEqual([
      "/a.ts",
      "/b.ts",
    ]);
  });

  it("ignores non-path values under path keys", () => {
    expect(extractPathsFromToolInput({ path: "not a path" })).toEqual([]);
  });
});

describe("getFilePathFromInput", () => {
  it("reads from common file fields", () => {
    expect(getFilePathFromInput({ filePath: "/a.ts" })).toBe("/a.ts");
    expect(getFilePathFromInput({ file_path: "/b.ts" })).toBe("/b.ts");
    expect(getFilePathFromInput({ targetFile: "/c.ts" })).toBe("/c.ts");
    expect(getFilePathFromInput({})).toBe("");
  });
});

describe("getDisplayPath", () => {
  it("strips base directory prefix", () => {
    expect(getDisplayPath("/base/src/file.ts", "/base")).toBe("src/file.ts");
  });

  it("returns dot when path equals base", () => {
    expect(getDisplayPath("/base", "/base")).toBe(".");
  });

  it("returns path as-is when no base", () => {
    expect(getDisplayPath("/base/file.ts")).toBe("/base/file.ts");
  });
});

describe("getDisplayTextWithRelativePaths", () => {
  it("replaces base dir with dot", () => {
    expect(getDisplayTextWithRelativePaths("/base/src/file.ts", "/base")).toBe("./src/file.ts");
  });
});

describe("formatTrackedPath", () => {
  it("strips base directory prefix", () => {
    expect(formatTrackedPath("/base/src/file.ts", "/base")).toBe("src/file.ts");
  });

  it("returns path unchanged when no prefix match", () => {
    expect(formatTrackedPath("/other/file.ts", "/base")).toBe("/other/file.ts");
  });
});
