import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createFixture, launch, runCli, SESSION_ID, stop, waitFor } from "./harness.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const rust = [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];

function clearCache(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
}

function index(output) {
  return JSON.parse(output.slice(output.indexOf("{")));
}

async function compareJson(fixture, flags) {
  const args = ["--json", "--agent", "codex", ...flags];
  clearCache(fixture);
  const expected = await runCli(fixture, args, reference);
  clearCache(fixture);
  const actual = await runCli(fixture, args, rust);
  assert.equal(expected.code, 0, `reference ${JSON.stringify(flags)}: ${expected.stderr}`);
  assert.equal(actual.code, expected.code, `Rust ${JSON.stringify(flags)}: ${actual.stderr}`);
  assert.deepEqual(index(actual.stdout), index(expected.stdout), JSON.stringify(flags));
}

test("CLI index flags match the fixed Node backend", async () => {
  const fixture = createFixture();
  try {
    for (const flags of [
      ["--days", "0"],
      ["--days", "-1"],
      ["--days", "not-a-number"],
      ["--days", "2.5"],
      ["--days", "+7"],
      ["--days"],
      ["--from", "2026-09-01", "--to", "2026-09-01", "--days", "1"],
      ["--from", "2026-09-02"],
      ["--days", "2", "--to", "2026-09-02"],
      ["--days", "1", "--to", "2026-08-31"],
      ["--from", "2026-09-01T10:00:00Z", "--to", "2026-09-01T11:00:00Z"],
      ["--days", "0", "--cwd", "."],
      ["--days", "0", "--cwd", "unrelated-project"],
      ["--days", "0", "--agent", "codex, claudecode"],
      ["--days", "0", "--agent", "unknown-agent"],
      ["--days", "0", "--session", `Codex://${SESSION_ID}`],
      ["--days", "0", "--session", "codex://opaque/path?query#fragment"],
      ["--days", "0", "--cache"],
      ["--days", "0", "--cache=false"],
      ["--days", "0", "--cache", "false"],
      ["--days", "0", "--no-cache"],
      ["--days", "0", "--no-cache", "--cache"],
      ["--days", "0", "--cache", "--no-cache"],
      ["--days", "0", "--clear-cache"],
      ["--days", "0", "--port", "abc"],
      ["--days", "0", "--port", "-1"],
      ["--days", "0", "--port", "99999"],
      ["-d0", "-a", "codex"],
    ])
      await compareJson(fixture, flags);
  } finally {
    fixture.dispose();
  }
});

test("CLI calendar bounds honor explicit TZ across daylight saving transitions", async () => {
  const fixture = createFixture();
  fixture.env.TZ = "America/New_York";
  try {
    const originals = readFileSync(fixture.source, "utf8").trim().split("\n").map(JSON.parse);
    for (const [updated, flags] of [
      ["2026-03-07T04:59:59Z", ["--days", "3", "--to", "2026-03-09"]],
      ["2026-03-07T05:00:00Z", ["--days", "3", "--to", "2026-03-09"]],
      ["2026-03-10T03:59:59.999Z", ["--from", "2026-03-07", "--to", "2026-03-09"]],
      ["2026-03-10T04:00:00Z", ["--from", "2026-03-07", "--to", "2026-03-09"]],
      ["2026-10-31T03:59:59Z", ["--days", "3", "--to", "2026-11-02"]],
      ["2026-10-31T04:00:00Z", ["--days", "3", "--to", "2026-11-02"]],
      ["2026-03-07T05:00:00Z", ["--from", "2026-03-07T00:00:00", "--to", "2026-03-09T23:59:59"]],
    ]) {
      writeFileSync(
        fixture.source,
        originals.map((record) => JSON.stringify({ ...record, timestamp: updated })).join("\n") +
          "\n",
      );
      utimesSync(fixture.source, new Date(updated), new Date(updated));
      await compareJson(fixture, flags);
    }
  } finally {
    fixture.dispose();
  }
});

test("CLI validates dates, sessions, remote access and TLS before scanning", async () => {
  const fixture = createFixture();
  const cert = join(fixture.root, "cert.pem"),
    key = join(fixture.root, "key.pem");
  writeFileSync(cert, "certificate");
  writeFileSync(key, "private key");
  try {
    for (const [flags, message] of [
      [["--from", "not-a-date"], /Invalid date/],
      [["--to", "2026-02-31"], /Invalid date/],
      [["--from", "2026-09-02", "--to", "2026-09-01"], /Invalid time window/],
      [["--session", "codex/session"], /Invalid session format/],
      [["--session", "codex://"], /Invalid session format/],
      [["--tls-cert", cert], /TLS requires both/],
      [["--tls-key", key], /TLS requires both/],
      [["--tls-cert", cert, "--tls-key", key, "--trust-proxy"], /only one of them terminates TLS/],
      [
        ["--tls-cert", `${cert}.missing`, "--tls-key", `${key}.missing`],
        /Unable to read the TLS certificate or key/,
      ],
      [["--tls-cert", cert, "--tls-key", key], /explicit remote access/],
      [["--host", "0.0.0.0"], /explicit remote access/],
      [["--trust-proxy", "--host", "0.0.0.0", "--remote-access"], /loopback --host/],
      [["--trust-proxy", "--remote-access"], /requires an HTTPS --public-url/],
      [["--public-url", "https://codesesh.example"], /requires --trust-proxy/],
      [["--trust-proxy", "--public-url", "not-a-url", "--remote-access"], /valid HTTPS origin/],
      ...[
        "http://codesesh.example",
        "https://user@codesesh.example",
        "https://codesesh.example/app",
        "https://codesesh.example?q=1",
        "https://codesesh.example#part",
      ].map((url) => [
        ["--trust-proxy", "--public-url", url, "--remote-access"],
        /HTTPS origin without credentials/,
      ]),
    ]) {
      const args = ["--json", ...flags];
      const expected = await runCli(fixture, args, reference),
        actual = await runCli(fixture, args, rust);
      assert.equal(expected.code, 1, JSON.stringify(flags));
      assert.equal(actual.code, 1, `${JSON.stringify(flags)}: ${actual.stderr}`);
      assert.match(expected.stderr, message);
      assert.match(actual.stderr, message);
      assert.equal(actual.stdout, "");
    }
    await compareJson(fixture, [
      "--days",
      "0",
      "--tls-cert",
      cert,
      "--tls-key",
      key,
      "--remote-access",
    ]);
    await compareJson(fixture, [
      "--days",
      "0",
      "--trust-proxy",
      "--public-url",
      "https://codesesh.example",
      "--remote-access",
    ]);
  } finally {
    fixture.dispose();
  }
});

test("CLI help and version terminate successfully", async () => {
  const fixture = createFixture();
  try {
    for (const flag of ["--help", "-h", "--version", "-v"]) {
      const expected = await runCli(fixture, [flag], reference),
        actual = await runCli(fixture, [flag], rust);
      assert.equal(expected.code, 0, flag);
      assert.equal(actual.code, 0, flag);
      if (flag.includes("version") || flag === "-v") {
        assert.match(expected.stdout, /1\.0\.12/);
        assert.match(actual.stdout, /1\.0\.12/);
      } else {
        for (const option of [
          "--agent",
          "--days",
          "--cwd",
          "--session",
          "--cache",
          "--tls-cert",
          "--trust-proxy",
          "--public-url",
          "--port",
        ]) {
          assert.ok(expected.stdout.includes(option), option);
          assert.ok(actual.stdout.includes(option), option);
        }
      }
    }
  } finally {
    fixture.dispose();
  }
});

async function startup(fixture, command, flags) {
  const process = launch(
    fixture,
    ["--agent", "codex", "--days", "0", "--noOpen", ...flags],
    command,
  );
  try {
    const url = await waitFor(() => {
      assert.equal(process.child.exitCode, null, JSON.stringify(process.output()));
      return [...process.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((m) => new URL(m[0]))
        .find((url) => url.searchParams.has("access_token"));
    }, "CLI startup URL");
    return url;
  } finally {
    await stop(process);
  }
}

test("CLI startup preserves opaque session paths, proxy origins and port prefix parsing", async () => {
  const fixture = createFixture();
  try {
    for (const flags of [
      ["--port", "0tail", "--session", "Codex://nested/path?query#part"],
      ["-p0", "--host", "localhost"],
      [
        "--port",
        "0",
        "--trust-proxy",
        "--public-url",
        "https://codesesh.example:8443",
        "--remote-access",
        "--session",
        `codex://${SESSION_ID}`,
      ],
    ]) {
      clearCache(fixture);
      const expected = await startup(fixture, reference, flags);
      clearCache(fixture);
      const actual = await startup(fixture, rust, flags);
      assert.equal(actual.pathname, expected.pathname);
      assert.equal(actual.protocol, expected.protocol);
      if (flags.includes("--trust-proxy")) assert.equal(actual.origin, expected.origin);
      assert.ok(actual.searchParams.get("access_token"));
    }
  } finally {
    fixture.dispose();
  }
});
