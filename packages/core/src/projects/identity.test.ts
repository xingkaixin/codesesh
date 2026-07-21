import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIdentityCache,
  computeIdentity,
  getProjectIdentityKey,
  matchesProjectIdentity,
  normalizeGitRemote,
  type IdentityFs,
} from "./identity.js";
import { realFs } from "./fs.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

function createFs(
  paths: Record<string, string | true>,
  remotes: Record<string, string> = {},
): IdentityFs {
  return {
    exists(path) {
      return paths[path] != null;
    },
    readText(path) {
      const value = paths[path];
      return typeof value === "string" ? value : null;
    },
    spawn(cmd, args, opts) {
      if (cmd === "git" && args.join(" ") === "config --get remote.origin.url") {
        const remote = remotes[opts.cwd];
        return remote ? { stdout: remote, exitCode: 0 } : { stdout: "", exitCode: 1 };
      }
      if (cmd === "git" && args.join(" ") === "rev-parse --git-common-dir") {
        return { stdout: ".git", exitCode: 0 };
      }
      return { stdout: "", exitCode: 1 };
    },
  };
}

describe("normalizeGitRemote", () => {
  it("normalizes ssh and https remotes", () => {
    expect(normalizeGitRemote("git@github.com:xingkaixin/codesesh.git")).toBe(
      "github.com/xingkaixin/codesesh",
    );
    expect(normalizeGitRemote("https://github.com/xingkaixin/codesesh.git")).toBe(
      "github.com/xingkaixin/codesesh",
    );
  });
});

describe("project identity comparison", () => {
  it("keeps equal keys from different kinds distinct", () => {
    const remote = { kind: "git_remote" as const, key: "github.com/acme/app" };
    const path = { kind: "path" as const, key: "github.com/acme/app" };

    expect(getProjectIdentityKey(remote)).toBe("git_remote:github.com/acme/app");
    expect(getProjectIdentityKey(path)).toBe("path:github.com/acme/app");
    expect(matchesProjectIdentity(remote, path)).toBe(false);
    expect(matchesProjectIdentity(remote, { ...remote })).toBe(true);
  });
});

describe("computeIdentity", () => {
  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue("/Users/test");
  });

  it("uses git remote identity from repository subdirectories", () => {
    const fs = createFs(
      {
        "/repo/.git": true,
        "/repo/package.json": JSON.stringify({ name: "codesesh" }),
      },
      { "/repo": "git@github.com:xingkaixin/codesesh.git" },
    );

    expect(computeIdentity("/repo/apps/web", fs)).toEqual({
      kind: "git_remote",
      key: "github.com/xingkaixin/codesesh",
      displayName: "codesesh",
    });
  });

  it("uses manifest path when git metadata is absent", () => {
    const fs = createFs({
      "/workspace/tool/package.json": JSON.stringify({ name: "tool" }),
    });

    expect(computeIdentity("/workspace/tool/src", fs)).toEqual({
      kind: "manifest_path",
      key: "/workspace/tool",
      displayName: "tool",
    });
  });

  it("uses git remote identity from Windows repository subdirectories", () => {
    const fs = createFs(
      {
        "D:\\repo\\.git": true,
        "D:\\repo\\package.json": JSON.stringify({ name: "codesesh" }),
      },
      { "D:\\repo": "git@github.com:xingkaixin/codesesh.git" },
    );

    expect(computeIdentity("D:\\repo\\apps\\web", fs)).toEqual({
      kind: "git_remote",
      key: "github.com/xingkaixin/codesesh",
      displayName: "codesesh",
    });
  });

  it("uses manifest path from Windows subdirectories", () => {
    const fs = createFs({
      "D:\\workspace\\tool\\package.json": JSON.stringify({ name: "tool" }),
    });

    expect(computeIdentity("D:\\workspace\\tool\\src", fs)).toEqual({
      kind: "manifest_path",
      key: "D:\\workspace\\tool",
      displayName: "tool",
    });
  });

  it("groups Codex scratch chats under Chats on POSIX paths", () => {
    vi.mocked(homedir).mockReturnValue("/Users/chen");

    expect(
      computeIdentity("/Users/chen/Documents/Codex/2026-05-22/new-chat", createFs({})),
    ).toEqual({
      kind: "synthetic",
      key: "codex:scratch",
      displayName: "Chats",
    });
  });

  it("groups Codex scratch chats under Chats on Windows paths", () => {
    vi.mocked(homedir).mockReturnValue("C:\\Users\\chen");

    expect(
      computeIdentity("C:\\Users\\chen\\Documents\\Codex\\2026-05-22\\new-chat", createFs({})),
    ).toEqual({
      kind: "synthetic",
      key: "codex:scratch",
      displayName: "Chats",
    });
  });

  it("does not let HOME override os.homedir for Codex scratch paths", () => {
    const originalHome = process.env["HOME"];
    process.env["HOME"] = "/tmp/fake-home";
    vi.mocked(homedir).mockReturnValue("/Users/chen");

    try {
      expect(
        computeIdentity("/Users/chen/Documents/Codex/2026-05-22/new-chat", createFs({}))?.key,
      ).toBe("codex:scratch");
      expect(
        computeIdentity("/tmp/fake-home/Documents/Codex/2026-05-22/new-chat", createFs({})),
      ).toEqual({
        kind: "path",
        key: "/tmp/fake-home/Documents/Codex/2026-05-22/new-chat",
        displayName: "new-chat",
      });
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  it("prefers real project signals inside Codex scratch directories", () => {
    vi.mocked(homedir).mockReturnValue("/Users/chen");
    const fs = createFs(
      {
        "/Users/chen/Documents/Codex/2026-05-22/new-chat/.git": true,
        "/Users/chen/Documents/Codex/2026-05-22/new-chat/package.json": JSON.stringify({
          name: "real-project",
        }),
      },
      {
        "/Users/chen/Documents/Codex/2026-05-22/new-chat": "git@github.com:acme/real-project.git",
      },
    );

    expect(computeIdentity("/Users/chen/Documents/Codex/2026-05-22/new-chat/src", fs)).toEqual({
      kind: "git_remote",
      key: "github.com/acme/real-project",
      displayName: "real-project",
    });
  });
});

// The module-level cache only activates for fs === realFs (see identity.ts);
// custom IdentityFs fakes above always bypass it, so these tests use a real
// temp directory to exercise the cached path without polluting other tests.
describe("computeIdentity caching (realFs)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "codesesh-identity-cache-"));
    // An empty .git dir makes findGitRoot succeed so computeIdentity spawns
    // git; the spawns themselves fail fast since it isn't a real repository.
    mkdirSync(join(repoDir, ".git"));
    clearIdentityCache();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    clearIdentityCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns git only once for repeated resolution of the same directory", () => {
    const spawnSpy = vi.spyOn(realFs, "spawn");

    computeIdentity(repoDir, realFs);
    const spawnsAfterFirstCall = spawnSpy.mock.calls.length;
    expect(spawnsAfterFirstCall).toBeGreaterThan(0);

    computeIdentity(repoDir, realFs);
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAfterFirstCall);
  });

  it("re-spawns after clearIdentityCache", () => {
    const spawnSpy = vi.spyOn(realFs, "spawn");

    computeIdentity(repoDir, realFs);
    const spawnsAfterFirstCall = spawnSpy.mock.calls.length;

    clearIdentityCache();
    computeIdentity(repoDir, realFs);
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAfterFirstCall * 2);
  });

  it("re-spawns once the TTL has elapsed", () => {
    vi.useFakeTimers();
    const spawnSpy = vi.spyOn(realFs, "spawn");

    computeIdentity(repoDir, realFs);
    const spawnsAfterFirstCall = spawnSpy.mock.calls.length;

    vi.advanceTimersByTime(10 * 60 * 1000);
    computeIdentity(repoDir, realFs);
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAfterFirstCall * 2);
  });
});
