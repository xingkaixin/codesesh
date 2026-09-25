import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createFixture,
  launch,
  stop,
  waitFor,
  runCli,
} from "../../../../../tests/backend-contract/harness.mjs";
const fixture = createFixture();
const home = fixture.env.GROK_HOME;
const id = "grok-contract";
const directory = join(home, "sessions", "project", id);
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, "summary.json"),
  JSON.stringify({
    info: { id, cwd: fixture.project },
    current_model_id: "grok-4.5",
    parent_session_id: "parent",
  }),
);
utimesSync(join(directory, "summary.json"), 1788220800.125125, 1788220800.125125);
let time = 1788220800000;
const u = (prompt, kind, fields) => ({
  method: ["turn_completed", "rewind_marker", "model_changed", "subagent_spawned"].includes(kind)
    ? "_x.ai/session/update"
    : "session/update",
  params: {
    update: { sessionUpdate: kind, ...fields },
    _meta: { promptId: prompt, eventId: `event-${++time}`, agentTimestampMs: time },
  },
});
const usage = (n) => ({
  usage: {
    inputTokens: n,
    outputTokens: 2,
    totalTokens: n + 2,
    cachedReadTokens: 3,
    cacheCreationTokens: 1,
    reasoningTokens: 1,
    costUsdTicks: 10000000,
    modelUsage: { "grok-4.5": { totalTokens: n + 2 } },
  },
});
const records = [
  u("p0", "user_message_chunk", {
    content: { type: "text", text: "Inspect" },
    _meta: { promptIndex: 0 },
  }),
  u("p0", "user_message_chunk", {
    content: { type: "text", text: " repository" },
    _meta: { promptIndex: 0 },
  }),
  u("p0", "agent_thought_chunk", { content: { type: "text", text: "Think" } }),
  u("p0", "agent_thought_chunk", { content: { type: "text", text: "ing" } }),
  u("p0", "tool_call", {
    toolCallId: "c",
    title: "read_file",
    rawInput: { target_file: "README.md" },
  }),
  u("p0", "tool_call_update", {
    toolCallId: "c",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "contents" } }],
  }),
  u("p0", "plan", { entries: [{ content: "Inspect", status: "pending" }] }),
  u("p0", "plan", { entries: [{ content: "Inspect", status: "completed" }] }),
  u("p0", "agent_message_chunk", { content: { type: "text", text: "Done" } }),
  u("p0", "turn_completed", usage(10)),
  u("p1", "user_message_chunk", {
    content: { type: "text", text: "Discard" },
    _meta: { promptIndex: 1 },
  }),
  u("p1", "agent_message_chunk", { content: { type: "text", text: "Discarded" } }),
  u("p1", "turn_completed", usage(20)),
  u("p1", "rewind_marker", { target_prompt_index: 1 }),
  u("p2", "user_message_chunk", {
    content: {
      type: "image",
      data: "aGVsbG8=",
      uri: "https://example.com/a.png",
      mimeType: "image/png",
    },
    _meta: { promptIndex: 1 },
  }),
  u("p2", "user_message_chunk", {
    content: { type: "image", uri: "https://example.com/url-only.png", mimeType: "image/png" },
    _meta: { promptIndex: 1 },
  }),
  u("p2", "agent_message_chunk", { content: { type: "text", text: "Replacement" } }),
  u("p2", "subagent_spawned", { child_session_id: "child" }),
  u("p2", "turn_completed", usage(30)),
];
delete records[0].params._meta.agentTimestampMs;
records[0].timestamp = 0.0005;
writeFileSync(join(directory, "updates.jsonl"), records.map((v) => JSON.stringify(v)).join("\n"));
const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
let server;
try {
  const cli = await runCli(fixture, ["--json", "--agent", "grok", "--days", "0"], reference);
  assert.equal(cli.code, 0, cli.stderr);
  const expectedHead = JSON.parse(cli.stdout).sessions[0];
  assert.ok(expectedHead);
  server = launch(
    fixture,
    ["--agent", "grok", "--days", "0", "--noOpen", "--host", "127.0.0.1", "--port", "0"],
    reference,
  );
  const url = await waitFor(
    () =>
      [...server.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((m) => new URL(m[0]))
        .find((u) => u.searchParams.has("access_token")),
    "reference Grok URL",
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
    return !s.active && s.completedAgents.includes("grok");
  }, "Grok completion");
  const expected = await get(`/api/sessions/grok/${id}`);
  execFileSync(
    "cargo",
    ["test", "-p", "codesesh-core", "grok::tests::export_reference_fixture", "--", "--ignored"],
    { env: { ...process.env, GROK_COMPARE_ROOT: home }, stdio: "inherit" },
  );
  const [actual] = JSON.parse(readFileSync(join(home, "rust.json"), "utf8"));
  assert.deepEqual(actual.head, expectedHead);
  if (actual.detail.message_cursor !== expected.message_cursor) {
    console.error("Reference image:", JSON.stringify(expected.messages[2].parts[0]));
    console.error("Rust image:", JSON.stringify(actual.detail.messages[2].parts[0]));
    console.error("Reference tool:", JSON.stringify(expected.messages[1].parts[1]));
    console.error("Rust tool:", JSON.stringify(actual.detail.messages[1].parts[1]));
  }
  assert.deepEqual(actual.detail, expected);
  console.log("Grok fixed-reference CLI and API projection match");
} finally {
  if (server) await stop(server);
  fixture.dispose();
}
