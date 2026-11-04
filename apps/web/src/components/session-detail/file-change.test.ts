import { describe, expect, it } from "vitest";
import { buildFileChangeSummaryFromActivity, type FileChangeSummary } from "./file-change";

describe("buildFileChangeSummaryFromActivity", () => {
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
      [
        {
          kind: "read",
          path: "/a.ts",
          count: 3,
          latestTime: 200,
          reference: { agentName: "claudecode", sessionId: "s1" },
          projectIdentityKey: "proj",
        },
      ],
      anchor,
    );
    expect(result.read[0]!.count).toBe(3);
    expect(result.read[0]!.latestAnchorId).toBe("anchor-1");
  });
});
