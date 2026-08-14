import { describe, expect, it } from "vitest";
import {
  buildFileActivityWhere,
  fileActivityFromRow,
  findFilePathHighlightRanges,
} from "../file-activity.js";

describe("cached file activity", () => {
  it("builds one parameterized predicate from structured filters", () => {
    const result = buildFileActivityWhere({
      agent: "codex",
      sessionId: "s1",
      projectKind: "path",
      projectKey: "/workspace/project",
      path: "src/App.tsx",
      kind: "edit",
      from: 10,
      to: 20,
    });

    expect(result.where).toContain("fa.agent_name = ?");
    expect(result.where).toContain("session_file_activity_path_fts");
    expect(result.params).toEqual([
      "codex",
      "s1",
      "path",
      "/workspace/project",
      '"src/App.tsx"',
      "edit",
      10,
      20,
    ]);
  });

  it("uses the resolved scope for identity and symmetric directory matching", () => {
    const result = buildFileActivityWhere({
      projectScope: {
        identity: { kind: "git_remote", key: "github.com/acme/app" },
        path: "/workspace/app/packages/web",
      },
    });

    expect(result.where).toContain("s.project_identity_kind = ? AND s.project_identity_key = ?");
    expect(result.where).toContain("REPLACE(LOWER(s.directory), char(92), '/')");
    expect(result.where).toContain("instr(?, REPLACE(LOWER(s.directory), char(92), '/') || '/')");
    expect(result.params).toEqual([
      "git_remote",
      "github.com/acme/app",
      "/workspace/app/packages/web",
      "/workspace/app/packages/web",
      "/workspace/app/packages/web",
    ]);
  });

  it("maps rows and highlights paths case-insensitively", () => {
    expect(
      fileActivityFromRow({
        agent_name: "codex",
        session_id: "s1",
        path: "src/App.tsx",
        kind: "write",
        count: 2,
        latest_time: 30,
      }),
    ).toEqual({
      reference: { agentName: "codex", sessionId: "s1" },
      projectIdentityKey: "",
      path: "src/App.tsx",
      kind: "write",
      count: 2,
      latestTime: 30,
    });
    expect(findFilePathHighlightRanges("src/App.tsx", "app")).toEqual([{ start: 4, end: 7 }]);
  });
});
