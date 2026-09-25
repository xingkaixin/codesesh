import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("differential driver rejects omissions, changed identities and reordered sessions", () => {
  const reference = {
    sessions: [
      { reference: { agentName: "codex", sessionId: "a" } },
      { reference: { agentName: "pi", sessionId: "b" } },
    ],
  };
  const commandFor = (value) =>
    JSON.stringify([
      process.execPath,
      "-e",
      `console.log(${JSON.stringify(JSON.stringify(value))})`,
      "--",
    ]);
  for (const [candidate, expectedStatus] of [
    [reference, 0],
    [{ sessions: reference.sessions.slice(1) }, 1],
    [
      { sessions: [{ reference: { agentName: "other", sessionId: "a" } }, reference.sessions[1]] },
      1,
    ],
    [{ sessions: [...reference.sessions].reverse() }, 1],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/compare-backends.mjs"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        CODESESH_REFERENCE_COMMAND: commandFor(reference),
        CODESESH_BACKEND_COMMAND: commandFor(candidate),
      },
    });
    assert.equal(result.status, expectedStatus, result.stderr);
  }
});
