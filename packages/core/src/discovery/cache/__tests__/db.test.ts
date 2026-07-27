import { describe, expect, it } from "vitest";
import {
  escapeRegExp,
  filePathFtsQuery,
  getSchemaEnsuredPath,
  likePattern,
  normalizeFilePathSearch,
  setSchemaEnsuredPath,
} from "../db.js";

describe("cache db helpers", () => {
  it("normalizes SQL and FTS search input", () => {
    expect(likePattern(" 50%_Done ")).toBe("%50\\%\\_done%");
    expect(normalizeFilePathSearch(' "src/App.tsx" ')).toBe("src/App.tsx");
    expect(filePathFtsQuery('src/"App".tsx')).toBe('"src/""App"".tsx"');
    expect(filePathFtsQuery("ab")).toBeNull();
    expect(escapeRegExp("a+b?.ts")).toBe("a\\+b\\?\\.ts");
  });

  it("owns the process-local schema guard", () => {
    setSchemaEnsuredPath("/cache/b.db");

    expect(getSchemaEnsuredPath()).toBe("/cache/b.db");

    setSchemaEnsuredPath(null);
  });
});
