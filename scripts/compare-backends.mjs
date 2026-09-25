import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { backendCommand, createFixture, runCli } from "../tests/backend-contract/harness.mjs";

const reference = process.env.CODESESH_REFERENCE_COMMAND
  ? JSON.parse(process.env.CODESESH_REFERENCE_COMMAND)
  : [
      process.execPath,
      resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
    ];
const fixture = createFixture();
try {
  const args = ["--json", "--agent", "codex", "--days", "0"];
  const expected = await runCli(fixture, args, reference);
  assert.equal(expected.code, 0, expected.stderr);
  const directory = join(fixture.root, ".cache", "codesesh");
  for (const suffix of ["", "-shm", "-wal"])
    rmSync(join(directory, `codesesh.db${suffix}`), { force: true });
  const actual = await runCli(fixture, args, backendCommand());
  assert.equal(actual.code, expected.code, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(expected.stdout));
  console.log("CLI session index matches the frozen Node reference");
} finally {
  fixture.dispose();
}
