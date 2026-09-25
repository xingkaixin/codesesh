import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERSIONED_MANIFESTS,
  checkReleaseVersions,
  versionFromTag,
  readManifests,
} from "./release-preflight.mjs";

function manifests(versions) {
  return VERSIONED_MANIFESTS.map((path, index) => ({
    path,
    version: versions[index] ?? versions[0],
  }));
}

describe("CS-149: release preflight", () => {
  it.each([
    ["v1.2.3", "1.2.3"],
    ["v0.17.0", "0.17.0"],
    ["v1.2.3-rc.1", "1.2.3-rc.1"],
    ["v1.2.3+build.5", "1.2.3+build.5"],
  ])("reads %s as %s", (tag, expected) => {
    expect(versionFromTag(tag)).toBe(expected);
  });

  it.each([
    ["no prefix", "1.2.3"],
    ["double prefix", "vv1.2.3"],
    ["incomplete", "v1.2"],
    ["not a version", "vlatest"],
    ["empty", ""],
  ])("rejects a %s tag", (_name, tag) => {
    expect(versionFromTag(tag)).toBeNull();
  });

  it("passes when the tag and every manifest agree", () => {
    const result = checkReleaseVersions({ tag: "v1.2.3", manifests: manifests(["1.2.3"]) });

    expect(result).toEqual({ ok: true, expected: "1.2.3", problems: [] });
  });

  it("names the manifest that drifted", () => {
    const result = checkReleaseVersions({
      tag: "v1.2.3",
      manifests: manifests(["1.2.3", "1.2.2", "1.2.3"]),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["apps/web/package.json is 1.2.2, expected 1.2.3"]);
  });

  it("reports every manifest when the tag itself drifted", () => {
    const result = checkReleaseVersions({ tag: "v1.3.0", manifests: manifests(["1.2.3"]) });

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(VERSIONED_MANIFESTS.length);
  });

  it("fails on a malformed tag without inspecting manifests", () => {
    const result = checkReleaseVersions({ tag: "release-1.2.3", manifests: manifests(["1.2.3"]) });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["Tag release-1.2.3 is not a v-prefixed semver tag"]);
  });

  it("checks manifests against each other when there is no tag", () => {
    expect(checkReleaseVersions({ tag: null, manifests: manifests(["1.2.3"]) }).ok).toBe(true);
    expect(
      checkReleaseVersions({
        tag: null,
        manifests: manifests(["1.2.3", "1.2.3", "0.9.0"]),
      }).problems,
    ).toEqual(["apps/www/package.json is 0.9.0, expected 1.2.3"]);
  });

  it("rejects a non-semver manifest version", () => {
    const result = checkReleaseVersions({
      tag: "v1.2.3",
      manifests: manifests(["next", "1.2.3", "1.2.3"]),
    });

    expect(result.problems).toEqual([
      "packages/contract/package.json has a non-semver version: next",
    ]);
  });
});

it("checks Cargo workspace version against browser and site manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "codesesh-versions-"));
  try {
    writeFileSync(
      join(root, "Cargo.toml"),
      '[workspace.package]\nversion = "1.2.4"\n\n[workspace.dependencies]\n',
    );
    for (const path of VERSIONED_MANIFESTS) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify({ version: "1.2.3" }));
    }
    const result = checkReleaseVersions({ tag: "v1.2.3", manifests: readManifests(root) });
    expect(result.problems).toEqual(["Cargo.toml is 1.2.4, expected 1.2.3"]);
    writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\n[package]\nversion = "1.2.3"\n');
    expect(() => readManifests(root)).toThrow("workspace.package version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
