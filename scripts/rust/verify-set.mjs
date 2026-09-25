import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { output, sha256, targets, version } from "./common.mjs";

const manifests = targets.map((target) => {
  const dir = join(output, target.target);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.target, target.target);
  assert.equal(manifest.version, version);
  assert.match(manifest.binarySha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files.length, 3);
  const smoke = JSON.parse(readFileSync(join(dir, "smoke-report.json"), "utf8"));
  assert.equal(smoke.target, target.target);
  assert.equal(smoke.version, version);
  assert.equal(smoke.binarySha256, manifest.binarySha256);
  assert.equal(smoke.passed, true);
  assert.equal(smoke.contracts, true, "Full installed backend contracts must pass on each target");
  assert.ok(smoke.embeddedWebAssets > 0, "Installed binary must serve the embedded Web assets");
  for (const file of manifest.files)
    assert.equal(sha256(join(dir, file.name)), file.sha256, file.name);
  return manifest;
});
const mainHashes = manifests.map(
  (manifest) => manifest.files.find((file) => file.name === manifest.mainPackage).sha256,
);
assert.equal(
  new Set(mainHashes).size,
  1,
  "All targets must contain the identical main npm package",
);
writeFileSync(
  join(output, "release-set.json"),
  `${JSON.stringify({ version, manifests }, null, 2)}\n`,
);
console.log(
  `Verified all ${targets.length} target packages; this command does not prove runtime compatibility or publish anything.`,
);
