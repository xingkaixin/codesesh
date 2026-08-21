import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertNoLocalDependencyReferences,
  createPublishManifest,
  validatePackedFiles,
} from "./package-artifact.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceManifest = JSON.parse(
  readFileSync(resolve(scriptDir, "../packages/cli/package.json"), "utf8"),
);
const publishedReadme = readFileSync(resolve(scriptDir, "../packages/cli/README.md"), "utf8");
const catalog = {
  "better-sqlite3": "^13.0.3",
};
const validFiles = [
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/scan-refresh-worker.js",
  "dist/search-index-worker.js",
  "dist/smart-tag-worker.js",
  "dist/web/index.html",
  "dist/web/assets/index-release123.js",
  "dist/web/assets/index-release123.css",
];

test("creates an installable publish manifest without mutating the source", () => {
  const source = structuredClone(sourceManifest);
  const publish = createPublishManifest(source, catalog);

  assert.equal(publish.dependencies["@codesesh/core"], undefined);
  assert.equal(publish.dependencies["better-sqlite3"], catalog["better-sqlite3"]);
  assert.equal(publish.devDependencies, undefined);
  assertNoLocalDependencyReferences(publish);
  assert.deepEqual(source, sourceManifest);
});

test("rejects unresolved catalog dependencies", () => {
  assert.throws(() => createPublishManifest(sourceManifest, {}), /better-sqlite3/);
});

test("accepts the complete npm artifact allowlist", () => {
  assert.doesNotThrow(() => validatePackedFiles(validFiles));
});

test("rejects missing runtime entries and Web assets", () => {
  for (const required of validFiles.slice(0, 7)) {
    assert.throws(() => validatePackedFiles(validFiles.filter((path) => path !== required)));
  }
  assert.throws(() =>
    validatePackedFiles(
      validFiles.filter((path) => path !== "dist/web/assets/index-release123.css"),
    ),
  );
  assert.throws(() =>
    validatePackedFiles(
      validFiles.filter((path) => path !== "dist/web/assets/index-release123.js"),
    ),
  );
});

test("rejects source files outside the publish allowlist", () => {
  assert.throws(() => validatePackedFiles([...validFiles, "src/index.ts"]));
});

test("documents the remote access security contract in the published README", () => {
  for (const flag of [
    "--remote-access",
    "--tls-cert",
    "--tls-key",
    "--trust-proxy",
    "--public-url",
  ]) {
    assert.ok(publishedReadme.includes("`" + flag + "`"), `README is missing ${flag}`);
  }
  assert.match(publishedReadme, /enforces a loopback backend/i);
  assert.match(publishedReadme, /cannot identify its sender/i);
  assert.match(publishedReadme, /plaintext/i);
  assert.match(publishedReadme, /X-Forwarded-Proto: https/);
});
