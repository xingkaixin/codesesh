import { describe, expect, it } from "vitest";
import type { MessagePart } from "../../lib/api";
import {
  buildFileChangeSummary,
  buildFileChangeSummaryFromActivity,
  buildToolAnchorId,
  classifyToolKind,
  summarizeFileChangeItems,
  type FileChangeRecord,
  type FileChangeSummary,
} from "./file-change";

function part(overrides?: Partial<MessagePart>): MessagePart {
  return { role: "tool", tool: "Read", title: "Read", ...overrides } as MessagePart;
}

describe("buildToolAnchorId", () => {
  it("formats as tool-{msg}-{tool}", () => {
    expect(buildToolAnchorId(3, 7)).toBe("tool-3-7");
  });
});

describe("classifyToolKind", () => {
  it("classifies read tools", () => {
    expect(classifyToolKind(part({ tool: "read", title: "read" }))).toBe("read");
  });

  it("classifies edit tools", () => {
    expect(classifyToolKind(part({ tool: "edit", title: "edit" }))).toBe("edit");
    expect(classifyToolKind(part({ tool: "apply_patch", title: "apply_patch" }))).toBe("edit");
  });

  it("classifies write tools", () => {
    expect(classifyToolKind(part({ tool: "write", title: "write" }))).toBe("write");
    expect(classifyToolKind(part({ tool: "create_file", title: "create_file" }))).toBe("write");
  });

  it("classifies delete tools", () => {
    expect(classifyToolKind(part({ tool: "delete", title: "delete" }))).toBe("delete");
  });

  it("returns null for unknown tools", () => {
    expect(classifyToolKind(part({ tool: "bash", title: "bash" }))).toBeNull();
  });
});

describe("summarizeFileChangeItems", () => {
  it("groups by path and counts", () => {
    const records: FileChangeRecord[] = [
      { kind: "read", path: "/a.ts", anchorId: "tool-0-0", time: 100, toolLabel: "Read" },
      { kind: "read", path: "/a.ts", anchorId: "tool-0-1", time: 200, toolLabel: "Read" },
      { kind: "read", path: "/b.ts", anchorId: "tool-0-2", time: 150, toolLabel: "Read" },
    ];
    const result = summarizeFileChangeItems(records);
    expect(result).toHaveLength(2);
    const aItem = result.find((r) => r.path === "/a.ts");
    expect(aItem?.count).toBe(2);
    expect(aItem?.latestTime).toBe(200);
    expect(aItem?.anchors).toHaveLength(2);
  });

  it("sorts by latestTime desc then path", () => {
    const records: FileChangeRecord[] = [
      { kind: "read", path: "/z.ts", anchorId: "t1", time: 100, toolLabel: "Read" },
      { kind: "read", path: "/a.ts", anchorId: "t2", time: 200, toolLabel: "Read" },
    ];
    const result = summarizeFileChangeItems(records);
    expect(result[0]!.path).toBe("/a.ts");
  });
});

describe("buildFileChangeSummary", () => {
  it("returns empty summary for no messages", () => {
    const result = buildFileChangeSummary([]);
    expect(result.toolAnchorIds.size).toBe(0);
    expect(result.summary.read).toEqual([]);
  });
});

describe("buildFileChangeSummaryFromActivity", () => {
  it("returns anchor summary when no activity", () => {
    const anchor: FileChangeSummary = {
      read: [
        {
          path: "/a.ts",
          count: 1,
          latestTime: 100,
          latestAnchorId: "t1",
          toolLabel: "Read",
          anchors: [],
        },
      ],
      edit: [],
      write: [],
      delete: [],
    };
    expect(buildFileChangeSummaryFromActivity(undefined, anchor)).toBe(anchor);
  });

  it("merges activity data with anchor info", () => {
    const anchor: FileChangeSummary = {
      read: [
        {
          path: "/a.ts",
          count: 1,
          latestTime: 100,
          latestAnchorId: "anchor-1",
          toolLabel: "Read",
          anchors: [{ anchorId: "anchor-1", time: 100, toolLabel: "Read" }],
        },
      ],
      edit: [],
      write: [],
      delete: [],
    };
    const result = buildFileChangeSummaryFromActivity(
      [{ kind: "read", path: "/a.ts", count: 3, latest_time: 200 }],
      anchor,
    );
    expect(result.read[0]!.count).toBe(3);
    expect(result.read[0]!.latestAnchorId).toBe("anchor-1");
  });
});
