import { describe, expect, it } from "vitest";
import {
  PROJECT_IDENTITY_KINDS,
  getProjectAgentKey,
  getProjectIdentityKey,
  isProjectIdentityKind,
  matchesProjectIdentity,
} from "../project-identity.js";

/** A representative key per kind, including ones with URL-significant characters. */
const KEY_BY_KIND = {
  git_remote: "github.com/acme/app",
  git_common_dir: "/Users/dev/work/app/.git",
  manifest_path: "/Users/dev/work/app/package.json",
  synthetic: "app@2",
  path: "/Users/dev/scratch/a b",
  loose: "~/Downloads",
} as const;

describe("CS-153: project identity", () => {
  it("covers every kind in the closed set", () => {
    expect(Object.keys(KEY_BY_KIND).sort()).toEqual([...PROJECT_IDENTITY_KINDS].sort());
  });

  // These strings reach SQLite rows and API responses, so they are wire format.
  it.each(PROJECT_IDENTITY_KINDS)("encodes a %s identity key unchanged", (kind) => {
    const key = KEY_BY_KIND[kind];

    expect(getProjectIdentityKey({ kind, key })).toBe(`${kind}:${key}`);
  });

  it.each(PROJECT_IDENTITY_KINDS)("recognizes %s as a kind", (kind) => {
    expect(isProjectIdentityKind(kind)).toBe(true);
  });

  it.each(["", "git", "GIT_REMOTE", "unknown", "path:extra"])("rejects %j as a kind", (value) => {
    expect(isProjectIdentityKind(value)).toBe(false);
  });

  it("matches only on both fields", () => {
    const identity = { kind: "path", key: "/repo" } as const;

    expect(matchesProjectIdentity(identity, { kind: "path", key: "/repo" })).toBe(true);
    expect(matchesProjectIdentity(identity, { kind: "loose", key: "/repo" })).toBe(false);
    expect(matchesProjectIdentity(identity, { kind: "path", key: "/other" })).toBe(false);
    expect(matchesProjectIdentity(null, { kind: "path", key: "/repo" })).toBe(false);
    expect(matchesProjectIdentity(undefined, { kind: "path", key: "/repo" })).toBe(false);
  });

  it("keeps two identities distinct when one key is a prefix of the other", () => {
    const shorter = getProjectIdentityKey({ kind: "path", key: "/repo" });
    const longer = getProjectIdentityKey({ kind: "path", key: "/repo/nested" });

    expect(shorter).not.toBe(longer);
  });

  it("scopes a project key to one agent, case-insensitively", () => {
    const projectKey = getProjectIdentityKey({ kind: "path", key: "/repo" });

    expect(getProjectAgentKey(projectKey, "Codex")).toBe(getProjectAgentKey(projectKey, "codex"));
    expect(getProjectAgentKey(projectKey, "codex")).not.toBe(
      getProjectAgentKey(projectKey, "claudecode"),
    );
    // The separator cannot appear in an agent name, so keys stay unambiguous.
    expect(getProjectAgentKey(projectKey, "codex")).toContain("\0");
  });
});
