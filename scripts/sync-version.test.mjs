import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSIONED_MANIFESTS } from "./release-preflight.mjs";
import { syncVersion } from "./sync-version.mjs";

const roots = [];
const dependency = `[[package]]
name = "external"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "unchanged"
`;
const localPackages = ["codesesh-cli", "codesesh-core"]
  .map((name) => `[[package]]\nname = "${name}"\nversion = "1.0.0"\ndependencies = ["external"]\n`)
  .join("\n");

function fixture(lock = `${dependency}\n${localPackages}`) {
  const root = mkdtempSync(join(tmpdir(), "codesesh-version-"));
  roots.push(root);
  writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\nversion = "2.3.4-beta.1"\n');
  writeFileSync(join(root, "Cargo.lock"), lock);
  for (const path of VERSIONED_MANIFESTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      JSON.stringify({ name: path, version: "1.0.0", private: true }),
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Cargo workspace version synchronization", () => {
  it("updates three manifests and only the two local lock records, then becomes a no-op", () => {
    const root = fixture();
    const cargo = readFileSync(join(root, "Cargo.toml"), "utf8");
    expect(syncVersion(root)).toEqual({
      version: "2.3.4-beta.1",
      updated: [...VERSIONED_MANIFESTS, "Cargo.lock"],
    });
    for (const path of VERSIONED_MANIFESTS) {
      expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toEqual({
        name: path,
        version: "2.3.4-beta.1",
        private: true,
      });
    }
    expect(readFileSync(join(root, "Cargo.lock"), "utf8")).toBe(
      `${dependency}\n${localPackages.replaceAll('version = "1.0.0"', 'version = "2.3.4-beta.1"')}`,
    );
    expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toBe(cargo);
    expect(syncVersion(root).updated).toEqual([]);
  });

  it.each([
    dependency,
    `${dependency}\n${localPackages}\n${localPackages}`,
    `${dependency}\n${localPackages.replace('name = "codesesh-cli"', 'name = "codesesh-cli"\nsource = "registry+example"')}`,
  ])("rejects ambiguous or nonlocal lock records before writing any files", (lock) => {
    const root = fixture(lock);
    const paths = [...VERSIONED_MANIFESTS, "Cargo.lock", "Cargo.toml"];
    const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
    expect(() => syncVersion(root)).toThrow(/Cargo.lock/);
    expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
  });
});
