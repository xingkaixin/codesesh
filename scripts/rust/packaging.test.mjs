import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { createNativeArchive, extractArchive, targets, validateBinary } from "./common.mjs";
import { normalizeMainArchive } from "./npm-archive.mjs";

test("main archive normalization preserves launcher bytes and restores executable mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "codesesh-main-tar-"));
  try {
    mkdirSync(join(directory, "package/bin"), { recursive: true });
    mkdirSync(join(directory, "verify"));
    const launcher = "#!/usr/bin/env node\nconsole.log('fixture');\n";
    writeFileSync(join(directory, "package/bin/codesesh.cjs"), launcher, { mode: 0o644 });
    execFileSync("tar", ["-czf", "main.tgz", "package/bin/codesesh.cjs"], { cwd: directory });
    const archive = join(directory, "main.tgz");
    normalizeMainArchive(archive);
    const normalized = readFileSync(archive);
    normalizeMainArchive(archive);
    assert.deepEqual(readFileSync(archive), normalized);
    extractArchive(directory, "main.tgz", "verify");
    const extracted = join(directory, "verify/package/bin/codesesh.cjs");
    assert.equal(readFileSync(extracted, "utf8"), launcher);
    if (process.platform !== "win32") assert.equal(statSync(extracted).mode & 0o777, 0o755);
    const damaged = gunzipSync(normalized);
    damaged[0] ^= 1;
    writeFileSync(archive, gzipSync(damaged));
    assert.throws(() => normalizeMainArchive(archive), /Invalid tar checksum/);
    writeFileSync(join(directory, "package/other.txt"), "no launcher");
    execFileSync("tar", ["-czf", "main.tgz", "package/other.txt"], { cwd: directory });
    assert.throws(() => normalizeMainArchive(archive), /Invalid main package tar structure/);
    writeFileSync(archive, normalized.subarray(0, 20));
    assert.throws(() => normalizeMainArchive(archive));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native archives round-trip from a directory with spaces and Unicode", () => {
  const directory = mkdtempSync(join(tmpdir(), "codesesh tar 中文 space "));
  try {
    mkdirSync(join(directory, "platform/bin"), { recursive: true });
    mkdirSync(join(directory, "verify"));
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    writeFileSync(join(directory, "platform/bin/codesesh.exe"), bytes);
    createNativeArchive(directory, "native.tar.gz", "codesesh.exe");
    extractArchive(directory, "native.tar.gz", "verify");
    assert.deepEqual(readFileSync(join(directory, "verify/codesesh.exe")), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release validation rejects text, truncation, and a different CPU or OS", () => {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-arch-"));
  const file = join(dir, "binary");
  try {
    for (const bytes of [
      Buffer.from("#!/bin/sh\nexit 0\n"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    ]) {
      writeFileSync(file, bytes);
      for (const target of targets)
        assert.throws(() => validateBinary(file, target), /Wrong binary/);
    }
    for (const target of targets) {
      const bytes = Buffer.alloc(128);
      if (target.format === "Mach-O") {
        bytes.writeUInt32LE(0xfeedfacf, 0);
        bytes.writeUInt32LE(target.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
      } else if (target.format === "ELF") {
        bytes.writeUInt32BE(0x7f454c46, 0);
        bytes[4] = 2;
        bytes[5] = 1;
        bytes.writeUInt16LE(0x3e, 18);
      } else {
        bytes.writeUInt16LE(0x5a4d, 0);
        bytes.writeUInt32LE(64, 60);
        bytes.writeUInt32LE(0x4550, 64);
        bytes.writeUInt16LE(0x8664, 68);
      }
      writeFileSync(file, bytes);
      validateBinary(file, target);
      for (const other of targets.filter((item) => item !== target)) {
        assert.throws(() => validateBinary(file, other), /Wrong binary/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
