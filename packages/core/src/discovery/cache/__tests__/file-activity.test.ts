import { describe, expect, it } from "vitest";
import {
  buildFileActivityWhere,
  fileActivityFromRow,
  highlightFilePath,
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
      agent_name: "codex",
      session_id: "s1",
      project_identity_key: "",
      path: "src/App.tsx",
      kind: "write",
      count: 2,
      latest_time: 30,
    });
    expect(highlightFilePath("src/App.tsx", "app")).toBe("src/<mark>App</mark>.tsx");
  });
});
