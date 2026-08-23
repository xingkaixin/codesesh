import { describe, expect, it } from "vitest";
import { extractFileActivityOccurrences, extractSessionFileActivity } from "../file-activity.js";
import type { Message } from "../../types/index.js";

describe("file activity extraction", () => {
  it("extracts Cursor v2 file tools consistently", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        time_created: 10,
        parts: [
          {
            type: "tool",
            tool: "read_file_v2",
            state: { status: "completed", input: { path: "src/a.ts" } },
          },
          {
            type: "tool",
            tool: "edit_file_v2",
            state: { status: "completed", input: { targetPath: "src/b.ts" } },
          },
        ],
      },
    ];

    expect(extractFileActivityOccurrences(messages)).toEqual([
      expect.objectContaining({ path: "src/a.ts", kind: "read" }),
      expect.objectContaining({ path: "src/b.ts", kind: "edit" }),
    ]);
  });

  it("extracts paths only from recognized file tool arguments", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        time_created: 10,
        parts: [
          {
            type: "tool",
            tool: "Read",
            state: { status: "completed", input: { file_path: "src/a.ts" } },
          },
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "cat src/ignored.ts" } },
          },
          {
            type: "tool",
            tool: "Write",
            state: { status: "completed", input: { path: "src/b.ts" } },
            time_created: 12,
          },
        ],
      },
    ];

    expect(extractFileActivityOccurrences(messages)).toEqual([
      {
        path: "src/a.ts",
        kind: "read",
        time: 10,
        tool_label: "Read",
        message_index: 0,
        tool_index: 0,
      },
      {
        path: "src/b.ts",
        kind: "write",
        time: 12,
        tool_label: "Write",
        message_index: 0,
        tool_index: 2,
      },
    ]);
  });

  it("aggregates repeated patch operations by kind and path", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        time_created: 10,
        parts: [
          {
            type: "tool",
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
          },
        ],
      },
    ];

    expect(extractSessionFileActivity("codex", "s1", "project", messages)).toEqual([
      expect.objectContaining({ path: "src/a.ts", kind: "edit", count: 2 }),
      expect.objectContaining({ path: "src/b.ts", kind: "delete", count: 1 }),
    ]);
  });

  it("keeps read activity when the input also contains typed content", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        time_created: 10,
        parts: [
          {
            type: "tool",
            tool: "Read",
            state: {
              status: "completed",
              input: {
                file_path: "src/a.ts",
                content: [{ type: "text", text: "file contents" }],
              },
            },
          },
        ],
      },
    ];

    expect(extractFileActivityOccurrences(messages)).toEqual([
      expect.objectContaining({ path: "src/a.ts", kind: "read" }),
    ]);
  });
});
