import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { test } from "node:test";
import { createFixture, DETAIL_PATH, readJson, runCli, startServer, stop } from "./harness.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const rust = [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];

function clearCache(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
}

for (const withUsage of [false, true]) {
  test(`Rust Codex CLI and HTTP slice match the frozen Node reference (usage: ${withUsage})`, async () => {
    const fixture = createFixture();
    let server;
    if (withUsage) {
      writeFileSync(
        join(fixture.root, ".cache/codesesh/models-dev-pricing.json"),
        JSON.stringify({
          timestamp: Date.now(),
          data: {
            "migration-fixture": { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002 },
          },
        }),
      );
      const total = {
        input_tokens: 20,
        output_tokens: 7,
        reasoning_output_tokens: 3,
        cached_input_tokens: 5,
        total_tokens: 27,
      };
      const record = {
        timestamp: "2026-09-01T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: total, last_token_usage: total },
        },
      };
      appendFileSync(fixture.source, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);
    }
    try {
      const expected = await runCli(
        fixture,
        ["--json", "--agent", "codex", "--days", "0"],
        reference,
      );
      clearCache(fixture);
      const actual = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
      assert.equal(expected.code, 0, expected.stderr);
      assert.equal(actual.code, 0, actual.stderr);
      assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(expected.stdout));
      clearCache(fixture);
      server = await startServer(fixture, reference);
      const expectedList = await readJson(server, "/api/sessions");
      const expectedDetail = await readJson(server, DETAIL_PATH);
      await stop(server);
      const frozenCache = readFileSync(join(fixture.root, ".cache/codesesh/codesesh.db"));
      const refused = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /existing Node cache/);
      assert.deepEqual(
        readFileSync(join(fixture.root, ".cache/codesesh/codesesh.db")),
        frozenCache,
      );
      clearCache(fixture);
      server = await startServer(fixture, rust);
      assert.deepEqual(await readJson(server, "/api/sessions"), expectedList);
      assert.deepEqual(await readJson(server, DETAIL_PATH), expectedDetail);
      await stop(server);
      server = await startServer(fixture, rust);
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
}
