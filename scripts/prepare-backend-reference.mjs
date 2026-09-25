import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reference = join(root, "tests", "reference");
const destination = join(root, "artifacts", "backend-reference", "registry");
const manifest = JSON.parse(readFileSync(join(reference, "manifest.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(reference, "package-lock.json"), "utf8"));
assert.equal(lock.packages["node_modules/codesesh"].version, manifest.version);
assert.equal(lock.packages["node_modules/codesesh"].integrity, manifest.registryIntegrity);
mkdirSync(destination, { recursive: true });
for (const file of ["package.json", "package-lock.json"])
  cpSync(join(reference, file), join(destination, file));
execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--no-audit", "--no-fund"],
  { cwd: destination, stdio: "inherit" },
);
const command = [
  process.execPath,
  join(destination, "node_modules", "codesesh", "dist", "index.js"),
];
assert.equal(
  execFileSync(command[0], [...command.slice(1), "--version"], { encoding: "utf8" }).trim(),
  manifest.version,
);
console.log(JSON.stringify(command));
