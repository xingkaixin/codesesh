import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import {
  backendCommand,
  createFixture,
  DETAIL_PATH,
  readJson,
  runCli,
  startServer,
  stop,
} from "../tests/backend-contract/harness.mjs";

const command = backendCommand();
const output = resolve(process.argv[2] ?? "artifacts/backend-benchmark.json");
const samples = [];
const measuredCommand =
  process.platform === "darwin"
    ? ["/usr/bin/time", "-l", ...command]
    : process.platform === "linux"
      ? ["/usr/bin/time", "-v", ...command]
      : command;

for (const scenario of ["version", "cold-json", "warm-json", "web-ready-with-scan"]) {
  for (let iteration = -1; iteration < 5; iteration++) {
    const fixture = createFixture();
    let server;
    try {
      const args =
        scenario === "version" ? ["--version"] : ["--json", "--agent", "codex", "--days", "0"];
      if (scenario === "warm-json") assert.equal((await runCli(fixture, args, command)).code, 0);
      const started = performance.now();
      let elapsedMs;
      let peakRssBytes = null;
      if (scenario === "web-ready-with-scan") {
        server = await startServer(fixture, command);
        elapsedMs = performance.now() - started;
        assert.equal((await readJson(server, DETAIL_PATH)).messages.length, 2);
      } else {
        const result = await runCli(fixture, args, measuredCommand);
        elapsedMs = performance.now() - started;
        assert.equal(result.code, 0, result.stderr);
        if (scenario === "version") assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:-.+)?$/);
        else assert.equal(JSON.parse(result.stdout).sessions.length, 1);
        const macRss = result.stderr.match(/(\d+)\s+maximum resident set size/);
        const linuxRss = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
        if (macRss) peakRssBytes = Number(macRss[1]);
        if (linuxRss) peakRssBytes = Number(linuxRss[1]) * 1024;
      }
      if (iteration >= 0) samples.push({ scenario, iteration, elapsedMs, peakRssBytes });
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  }
}

const evaluatorFiles = ["scripts/benchmark-backend.mjs", "tests/backend-contract/harness.mjs"];
const report = {
  generatedAt: new Date().toISOString(),
  command,
  environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, node: process.version },
  evaluator: Object.fromEntries(
    evaluatorFiles.map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  fixture: { sessions: 1, messages: 2, pricing: "seeded disk cache", dates: "2026-09-01 UTC" },
  method: {
    warmups: 1,
    samplesPerScenario: 5,
    osPageCacheCleared: false,
    peakRss: "One-shot process maximum RSS; web RSS not measured",
    scope: "P0 starter workload, not a large-history benchmark",
  },
  samples,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(output);
