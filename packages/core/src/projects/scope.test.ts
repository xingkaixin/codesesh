import { describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../types/index.js";
import type { IdentityFs } from "./identity.js";
import { filterSessionsByProjectScope } from "./scope.js";

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: "/repo",
    time_created: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

describe("filterSessionsByProjectScope", () => {
  it("matches exact, query parent, session parent, and project identity scopes", () => {
    const sessions = [
      makeSession("exact", { directory: "/home/user/project" }),
      makeSession("child", { directory: "/home/user/project/src" }),
      makeSession("parent", { directory: "/home/user" }),
      makeSession("identity", {
        directory: "/elsewhere",
        project_identity: {
          kind: "path",
          key: "/home/user/project",
          displayName: "project",
        },
      }),
      makeSession("sibling", { directory: "/home/user/projectile" }),
    ];

    const result = filterSessionsByProjectScope(sessions, "/home/user/project");

    expect(result.map((session) => session.id)).toEqual(["exact", "child", "parent", "identity"]);
  });

  it("computes the query project identity once for all sessions", () => {
    const spawn = vi.fn<IdentityFs["spawn"]>(() => ({
      stdout: "git@github.com:acme/app.git",
      exitCode: 0,
    }));
    const fs: IdentityFs = {
      exists(path) {
        return path === "/repo/.git";
      },
      readText() {
        return null;
      },
      spawn,
    };
    const sessions = Array.from({ length: 5 }, (_, index) =>
      makeSession(`s${index}`, {
        directory: `/other/${index}`,
        project_identity: {
          kind: "git_remote",
          key: "github.com/acme/app",
          displayName: "app",
        },
      }),
    );

    const result = filterSessionsByProjectScope(sessions, "/repo/packages/web", fs);

    expect(result).toHaveLength(5);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
