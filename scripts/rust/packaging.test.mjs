import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { targets, validateBinary } from "./common.mjs";

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
