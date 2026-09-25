import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const template = join(root, "crates/codesesh-cli/npm");
export const targets = JSON.parse(readFileSync(join(template, "targets.json"), "utf8"));
export const version = readFileSync(join(root, "Cargo.toml"), "utf8").match(
  /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)[1];
export const output = join(root, "artifacts/rust-packaging");

export function targetFor(name) {
  const target = name
    ? targets.find((item) => item.target === name)
    : targets.find((item) => item.platform === process.platform && item.arch === process.arch);
  if (!target)
    throw new Error(`Unsupported target ${name ?? `${process.platform}/${process.arch}`}`);
  return target;
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
}

export function npm(args, options = {}) {
  if (process.platform !== "win32") return run("npm", args, options);
  const commands = run("where.exe", ["npm.cmd"]).trim().split(/\r?\n/);
  const cli = [
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...commands.map((path) => join(dirname(path), "node_modules/npm/bin/npm-cli.js")),
  ].find(existsSync);
  if (!cli) throw new Error("Cannot locate npm-cli.js for shell-free Windows execution");
  return run(process.execPath, [cli, ...args], options);
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateBinary(path, expected) {
  const bytes = readFileSync(path);
  let format, arch;
  if (
    bytes.length >= 20 &&
    bytes.readUInt32BE(0) === 0x7f454c46 &&
    bytes[4] === 2 &&
    bytes[5] === 1
  ) {
    format = "ELF";
    arch = bytes.readUInt16LE(18) === 0x3e ? "x64" : "unknown";
  } else if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    format = "Mach-O";
    arch = { [0x01000007]: "x64", [0x0100000c]: "arm64" }[bytes.readUInt32LE(4)];
  } else if (bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 <= bytes.length && bytes.readUInt32LE(offset) === 0x4550) {
      format = "PE";
      arch = bytes.readUInt16LE(offset + 4) === 0x8664 ? "x64" : "unknown";
    }
  }
  if (format !== expected.format || arch !== expected.arch)
    throw new Error(
      `Wrong binary ${path}: ${format}/${arch}, expected ${expected.format}/${expected.arch}`,
    );
}
