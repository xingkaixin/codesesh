import { describe, expect, it } from "vitest";
import { listCachedProjectGroups } from "../project-groups.js";
import { makeSessionHead } from "./fixtures.js";

describe("cached project groups", () => {
  it("groups an explicit session set without opening cache storage", () => {
    const sessions = [
      makeSessionHead("one"),
      makeSessionHead("two", { slug: "claudecode/two", time_updated: 1_800_000_000_000 }),
      makeSessionHead("loose", {
        project_identity: { kind: "loose", key: "scratch", displayName: "Scratch" },
      }),
    ];

    expect(listCachedProjectGroups(sessions)).toEqual([
      {
        identityKind: "path",
        identityKey: "/workspace/project",
        displayName: "project",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: 1_800_000_000_000,
      },
      {
        identityKind: "loose",
        identityKey: "scratch",
        displayName: "Scratch",
        sources: ["codex"],
        sessionCount: 1,
        lastActivity: 1_700_000_000_001,
      },
    ]);
  });
});
