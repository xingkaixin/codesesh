import { describe, expect, it } from "vitest";
import { extractFileToolOperations } from "../file-activity.js";

describe("file activity extraction", () => {
  it("extracts Cursor v2 file tools consistently", () => {
    expect(
      extractFileToolOperations({
        tool: "read_file_v2",
        state: { status: "completed", input: { path: "src/a.ts" } },
      }),
    ).toEqual([{ path: "src/a.ts", kind: "read" }]);
    expect(
      extractFileToolOperations({
        tool: "edit_file_v2",
        state: { status: "completed", input: { targetPath: "src/b.ts" } },
      }),
    ).toEqual([{ path: "src/b.ts", kind: "edit" }]);
  });

  it("extracts paths only from recognized file tool arguments", () => {
    expect(
      extractFileToolOperations({
        tool: "Read",
        state: { status: "completed", input: { file_path: "src/a.ts" } },
      }),
    ).toEqual([{ path: "src/a.ts", kind: "read" }]);
    expect(
      extractFileToolOperations({
        tool: "bash",
        state: { status: "completed", input: { command: "cat src/ignored.ts" } },
      }),
    ).toEqual([]);
    expect(
      extractFileToolOperations({
        tool: "Write",
        state: { status: "completed", input: { path: "src/b.ts" } },
      }),
    ).toEqual([{ path: "src/b.ts", kind: "write" }]);
  });

  it("retains repeated patch operations for later aggregation", () => {
    expect(
      extractFileToolOperations({
        tool: "apply_patch",
        state: {
          status: "completed",
          input: {
            content: [
              { type: "update_file", path: "src/a.ts" },
              { type: "update_file", path: "src/a.ts" },
              { type: "delete_file", path: "src/b.ts" },
            ],
          },
        },
      }),
    ).toEqual([
      { path: "src/a.ts", kind: "edit" },
      { path: "src/a.ts", kind: "edit" },
      { path: "src/b.ts", kind: "delete" },
    ]);
  });

  it("keeps read activity when the input also contains typed content", () => {
    expect(
      extractFileToolOperations({
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: "src/a.ts", content: [{ type: "text", text: "file contents" }] },
        },
      }),
    ).toEqual([{ path: "src/a.ts", kind: "read" }]);
  });
});
