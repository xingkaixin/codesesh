import { describe, expect, it } from "vitest";
import {
  escapeRegExp,
  filePathFtsQuery,
  likePattern,
  normalizeFilePathSearch,
  setFtsIntegrityCheckedPath,
  setSchemaEnsuredPath,
  getFtsIntegrityCheckedPath,
  getSchemaEnsuredPath,
} from "../db.js";

describe("cache db helpers", () => {
  it("normalizes SQL and FTS search input", () => {
    expect(likePattern(" 50%_Done ")).toBe("%50\\%\\_done%");
    expect(normalizeFilePathSearch(' "src/App.tsx" ')).toBe("src/App.tsx");
    expect(filePathFtsQuery('src/"App".tsx')).toBe('"src/""App"".tsx"');
    expect(filePathFtsQuery("ab")).toBeNull();
    expect(escapeRegExp("a+b?.ts")).toBe("a\\+b\\?\\.ts");
  });

  it("owns the process-local schema guards", () => {
    setFtsIntegrityCheckedPath("/cache/a.db");
    setSchemaEnsuredPath("/cache/b.db");

    expect(getFtsIntegrityCheckedPath()).toBe("/cache/a.db");
    expect(getSchemaEnsuredPath()).toBe("/cache/b.db");

    setFtsIntegrityCheckedPath(null);
    setSchemaEnsuredPath(null);
  });
});
