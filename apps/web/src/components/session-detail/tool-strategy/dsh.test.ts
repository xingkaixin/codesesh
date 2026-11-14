import { describe, expect, it } from "vitest";
import type { ToolPart } from "@codesesh/contract";
import { getToolDisplayStrategy, normalizeToolState } from "./index";

function display(tool: ToolPart) {
  return getToolDisplayStrategy("dsh", tool, normalizeToolState(tool), "/repo");
}

describe("DSH file and search context", () => {
  it("shows explicit truncation and the full glob total without duplicating paths", () => {
    const paths = ["/repo/src/first.ts", "/repo/src/second.ts"];
    expect(
      display({
        type: "tool",
        tool: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/*.ts" },
          output: [{ type: "text", text: paths.join("\n") }],
          metadata: { shape: "glob", paths, truncated: true, total: 269 },
        },
      }),
    ).toMatchObject({
      secondaryText: "**/*.ts",
      details: [
        { label: "Output", value: "Truncated" },
        { label: "Total", value: "269" },
      ],
      outputContent: { kind: "plain", text: paths.join("\n"), isCode: false },
    });
  });

  it("keeps the returned read range and total alongside the file content", () => {
    expect(
      display({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { file_path: "/repo/src/example.ts", limit: 2 },
          output: [{ type: "text", text: "first\nsecond" }],
          metadata: {
            path: "/repo/src/example.ts",
            offset: 1,
            lines: [
              { number: 1, text: "first" },
              { number: 2, text: "second" },
            ],
            totalLines: 261,
            lang: "typescript",
          },
        },
      }),
    ).toMatchObject({
      secondaryText: "src/example.ts",
      details: [
        { label: "Offset", value: "1" },
        { label: "Lines", value: "2" },
        { label: "Total", value: "261" },
      ],
      outputContent: { kind: "plain", text: "first\nsecond", isCode: true },
    });
  });

  it("leaves absent result metadata unknown", () => {
    for (const tool of ["read", "glob"]) {
      expect(
        display({
          type: "tool",
          tool,
          state: { status: "completed", input: { file_path: "/repo/a.ts", pattern: "*.ts" } },
        }).details,
      ).toEqual([]);
    }
  });
});
