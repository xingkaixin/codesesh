import { describe, expect, it } from "vitest";
import { computeIdentity, normalizeGitRemote, type IdentityFs } from "./identity.js";

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

describe("computeIdentity", () => {
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
});
