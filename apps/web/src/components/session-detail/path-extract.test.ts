import { describe, expect, it } from "vitest";
import {
  formatTrackedPath,
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "./path-extract";

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
