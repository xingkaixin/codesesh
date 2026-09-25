import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createFixture,
  launch,
  stop,
  waitFor,
  readJson,
  runCli,
} from "../../../../../tests/backend-contract/harness.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const candidate = [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];
const created = 1788256800000.25;

function clearCache(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
}
function database(fixture, agent, v2) {
  const path =
    agent === "zcode" ? join(fixture.root, ".zcode/cli/db/db.sqlite") : fixture.env.OPENCODE_DB;
  if (agent === "zcode") mkdirSync(join(fixture.root, ".zcode/cli/db"), { recursive: true });
  const db = new DatabaseSync(path);
  if (v2) {
    db.exec(
      "CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,fork_session_id TEXT,title TEXT,directory TEXT,path TEXT,version TEXT,summary_files INTEGER,time_created REAL,time_updated REAL,cost REAL,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER);CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created REAL,time_updated REAL,data TEXT)",
    );
    db.prepare(
      "INSERT INTO session_v2 VALUES('root',NULL,NULL,'',?,NULL,'2.0.15',2,?,?,0.5,10,5,2,3,1)",
    ).run(fixture.project, created, created + 5.5);
    const message = db.prepare("INSERT INTO session_message VALUES(?, 'root', ?, ?, ?, ?, ?)");
    message.run(
      "m-user",
      "user",
      1,
      created + 0.25,
      created + 0.25,
      JSON.stringify({
        text: "Implement fractional parser 中文",
        files: [{ mime: "image/png", data: "aGVsbG8=" }],
      }),
    );
    message.run(
      "m-assistant",
      "assistant",
      2,
      created + 1.25,
      created + 1.5,
      JSON.stringify({
        agent: "build",
        model: { id: "migration-fixture", providerID: "test" },
        time: { completed: created + 4.25 },
        cost: 0.5,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        content: [
          { type: "reasoning", text: "Inspect" },
          {
            type: "tool",
            id: "call-1",
            name: "read",
            time: { created: created + 2.25 },
            state: {
              status: "completed",
              input: { path: "src/lib.rs" },
              content: [{ type: "text", text: "result" }],
            },
          },
          { type: "text", text: "Finished" },
        ],
      }),
    );
  } else {
    db.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created REAL,time_updated REAL,directory TEXT,version TEXT,summary_files TEXT,slug TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created REAL);CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT,time_created REAL)",
    );
    db.prepare("INSERT INTO session VALUES('root',NULL,'',?,?,?,'1.0','[]',NULL)").run(
      created,
      created + 5.5,
      fixture.project,
    );
    const message = db.prepare("INSERT INTO message VALUES(?,'root',?,?)");
    message.run("m-user", JSON.stringify({ role: "user" }), created + 0.25);
    message.run(
      "m-assistant",
      JSON.stringify({
        role: "assistant",
        modelID: "migration-fixture",
        providerID: "test",
        tokens: { input: 10, output: 5 },
        cost: 0.5,
      }),
      created + 1.25,
    );
    const part = db.prepare("INSERT INTO part VALUES(?,?,?,?)");
    part.run(
      "p1",
      "m-user",
      JSON.stringify({ type: "text", text: "Implement fractional parser 中文" }),
      created + 0.25,
    );
    part.run(
      "p2",
      "m-assistant",
      JSON.stringify({
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: { status: "completed", input: { path: "src/lib.rs" }, output: "result" },
      }),
      created + 2.25,
    );
    part.run(
      "p3",
      "m-assistant",
      JSON.stringify({ type: "text", text: "Finished" }),
      created + 3.25,
    );
  }
  db.close();
}
async function start(fixture, agent, command) {
  const process = launch(
    fixture,
    ["--agent", agent, "--days", "0", "--noOpen", "--host", "127.0.0.1", "--port", "0"],
    command,
  );
  try {
    const startup = await waitFor(() => {
      assert.equal(process.child.exitCode, null, JSON.stringify(process.output()));
      return [...process.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((match) => new URL(match[0]))
        .find((url) => url.searchParams.has("access_token"));
    }, "startup");
    startup.hostname = "127.0.0.1";
    const request = (path) =>
      fetch(new URL(path, startup.origin), {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${startup.searchParams.get("access_token")}` },
      });
    await waitFor(async () => {
      const status = await (await request("/api/status")).json();
      return !status.active && status.completedAgents.includes(agent);
    }, "initial scan");
    return { ...process, request };
  } catch (error) {
    await stop(process);
    throw error;
  }
}
for (const [agent, v2] of [
  ["opencode", false],
  ["opencode", true],
  ["zcode", false],
]) {
  test(
    `${agent} ${v2 ? "V2" : "V1"} fractional CLI and complete HTTP cursor parity`,
    { skip: agent === "zcode" && process.platform === "linux" },
    async () => {
      const fixture = createFixture();
      let server;
      try {
        database(fixture, agent, v2);
        const expectedCli = await runCli(
          fixture,
          ["--agent", agent, "--days", "0", "--json"],
          reference,
        );
        assert.equal(expectedCli.code, 0, expectedCli.stderr);
        clearCache(fixture);
        const actualCli = await runCli(
          fixture,
          ["--agent", agent, "--days", "0", "--json"],
          candidate,
        );
        assert.equal(actualCli.code, 0, actualCli.stderr);
        assert.deepEqual(JSON.parse(actualCli.stdout), JSON.parse(expectedCli.stdout));
        clearCache(fixture);
        server = await start(fixture, agent, reference);
        const expectedList = await readJson(server, "/api/sessions");
        const expectedDetail = await readJson(server, `/api/sessions/${agent}/root`);
        await stop(server);
        server = undefined;
        clearCache(fixture);
        server = await start(fixture, agent, candidate);
        assert.deepEqual(await readJson(server, "/api/sessions"), expectedList);
        assert.deepEqual(await readJson(server, `/api/sessions/${agent}/root`), expectedDetail);
      } finally {
        if (server) await stop(server);
        fixture.dispose();
      }
    },
  );
}
