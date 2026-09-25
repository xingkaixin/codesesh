import assert from "node:assert/strict";
import { resolve } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { createFixture, DETAIL_PATH, readJson, runCli, startServer, stop } from "./harness.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const rust = [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];

test("Rust Codex CLI and HTTP slice match the frozen Node reference", async () => {
  const fixture = createFixture();
  let server;
  try {
    const expected = await runCli(
      fixture,
      ["--json", "--agent", "codex", "--days", "0"],
      reference,
    );
    const actual = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
    assert.equal(expected.code, 0, expected.stderr);
    assert.equal(actual.code, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(expected.stdout));
    server = await startServer(fixture, reference);
    const expectedList = await readJson(server, "/api/sessions");
    const expectedDetail = await readJson(server, DETAIL_PATH);
    await stop(server);
    server = await startServer(fixture, rust);
    assert.deepEqual(await readJson(server, "/api/sessions"), expectedList);
    assert.deepEqual(await readJson(server, DETAIL_PATH), expectedDetail);
    assert.equal((await fetch(`${server.origin}/api/sessions`)).status, 401);
    const rejectedHost = await new Promise((resolve, reject) => {
      const req = request(
        `${server.origin}/`,
        { headers: { Host: "attacker.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rejectedHost, 403);
    assert.equal(
      (await server.request("/api/sessions", { headers: { Origin: "https://attacker.invalid" } }))
        .status,
      403,
    );
  } finally {
    if (server) await stop(server);
    fixture.dispose();
  }
});
