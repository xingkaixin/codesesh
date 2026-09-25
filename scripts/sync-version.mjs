import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifests, VERSIONED_MANIFESTS, versionFromTag } from "./release-preflight.mjs";

export function syncVersion(repoRoot) {
  const version = readManifests(repoRoot)[0].version;
  if (versionFromTag(`v${version}`) !== version) {
    throw new Error("Cargo workspace version must be semver");
  }
  const changes = VERSIONED_MANIFESTS.map((path) => {
    const before = readFileSync(join(repoRoot, path), "utf8");
    const manifest = JSON.parse(before);
    const after =
      manifest.version === version
        ? before
        : `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
    return { path, before, after };
  });
  const lock = readFileSync(join(repoRoot, "Cargo.lock"), "utf8");
  const blocks = lock.split(/(?=^\[\[package\]\]\s*$)/m);
  for (const name of ["codesesh-core", "codesesh-cli"]) {
    const matches = blocks.flatMap((block, index) =>
      new RegExp(`^name = "${name}"$`, "m").test(block) ? [index] : [],
    );
    if (matches.length !== 1) throw new Error(`Cargo.lock must contain one local ${name} package`);
    const index = matches[0];
    const block = blocks[index];
    if (/^(?:source|checksum)\s*=/m.test(block)) {
      throw new Error(`Cargo.lock ${name} must be a local workspace package`);
    }
    if ([...block.matchAll(/^version = "[^"]+"$/gm)].length !== 1) {
      throw new Error(`Cargo.lock ${name} must contain one version`);
    }
    blocks[index] = block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  }
  changes.push({ path: "Cargo.lock", before: lock, after: blocks.join("") });
  const updated = changes.filter(({ before, after }) => before !== after);
  for (const { path, after } of updated) writeFileSync(join(repoRoot, path), after);
  return { version, updated: updated.map(({ path }) => path) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = syncVersion(join(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(`Version ${result.version}: ${result.updated.length} files synchronized`);
}
