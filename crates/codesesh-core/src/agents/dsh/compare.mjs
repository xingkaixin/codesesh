import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createFixture,
  launch,
  stop,
  waitFor,
  runCli,
} from "../../../../../tests/backend-contract/harness.mjs";
const fixture = createFixture();
const home = fixture.env.DSH_HOME;
const id = "golden";
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/node-projection.json", import.meta.url), "utf8"),
);
golden.header.cwd = fixture.project;
const project = "--" + fixture.project.replace(/[\\/:]+/g, "-").replace(/^-+/, "") + "--";
const directory = join(home, "sessions", project, id);
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, "session.jsonl"),
  [golden.header, ...golden.events].map((v) => JSON.stringify(v) + "\n").join(""),
);
const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
let server;
try {
  const cli = await runCli(fixture, ["--json", "--agent", "dsh", "--days", "0"], reference);
  assert.equal(cli.code, 0, cli.stderr);
  const expectedHead = JSON.parse(cli.stdout).sessions[0];
  assert.ok(expectedHead);
  server = launch(
    fixture,
    ["--agent", "dsh", "--days", "0", "--noOpen", "--host", "127.0.0.1", "--port", "0"],
    reference,
  );
  const url = await waitFor(
    () =>
      [...server.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((m) => new URL(m[0]))
        .find((u) => u.searchParams.has("access_token")),
    "reference DSH URL",
  );
  url.hostname = "127.0.0.1";
  const get = async (path) =>
    (
      await fetch(new URL(path, url.origin), {
        headers: { Authorization: `Bearer ${url.searchParams.get("access_token")}` },
      })
    ).json();
  await waitFor(async () => {
    const s = await get("/api/status");
    return !s.active && s.completedAgents.includes("dsh");
  }, "DSH completion");
  const expected = await get(`/api/sessions/dsh/${id}`);
  execFileSync(
    "cargo",
    ["test", "-p", "codesesh-core", "dsh::tests::export_reference_fixture", "--", "--ignored"],
    { env: { ...process.env, DSH_COMPARE_ROOT: home }, stdio: "inherit" },
  );
  const [actual] = JSON.parse(readFileSync(join(home, "rust.json"), "utf8"));
  assert.deepEqual(actual.head, expectedHead);
  assert.deepEqual(actual.detail, expected);
  console.log("DSH fixed-reference CLI and API projection match");
} finally {
  if (server) await stop(server);
  fixture.dispose();
}
