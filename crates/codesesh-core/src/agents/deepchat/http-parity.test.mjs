import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createFixture,
  launch,
  waitFor,
  stop,
  readJson,
} from "../../../../../tests/backend-contract/harness.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const rust = [
  resolve(
    process.env.CODESESH_RUST_BINARY ??
      `target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`,
  ),
];
const baseTime = 1788256800000;

function database(fixture, agent, relative) {
  const roots = {
    deepchat: "DEEPCHAT_USER_DATA_DIR",
    cherrystudio: "CHERRYSTUDIO_USER_DATA_DIR",
    "minimax-code": "MINIMAX_DATA_DIR",
  };
  const path = join(fixture.env[roots[agent]], relative);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const folder = agent.replaceAll("-", "_");
  db.exec(readFileSync(new URL(`../${folder}/fixture.sql`, import.meta.url), "utf8"));
  return { db, path };
}
function deepchat(fixture) {
  const { db, path } = database(fixture, "deepchat", "app_db/agent.db");
  db.prepare(
    "INSERT INTO new_sessions (id,agent_id,title,project_dir,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(
    "desktop-parent",
    "deepchat",
    "Desktop 中文 🔎",
    fixture.project,
    baseTime + 0.25,
    baseTime + 1.5,
  );
  db.prepare(
    "INSERT INTO new_sessions (id,agent_id,title,project_dir,parent_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    "desktop-child",
    "codex-acp",
    "Child",
    fixture.project,
    "desktop-parent",
    baseTime + 0.375,
    baseTime + 1.625,
  );
  db.prepare("INSERT INTO deepchat_sessions VALUES (?,?,?)").run(
    "desktop-parent",
    "migration-fixture",
    "fixture",
  );
  const message = db.prepare(
    "INSERT INTO deepchat_messages (id,session_id,order_seq,role,content,metadata,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  message.run(
    "user",
    "desktop-parent",
    1,
    "user",
    JSON.stringify({ text: "stale" }),
    "{}",
    "sent",
    baseTime + 10.25,
    baseTime + 10.625,
  );
  message.run(
    "answer",
    "desktop-parent",
    2,
    "assistant",
    "[]",
    JSON.stringify({ inputTokens: 9999, outputTokens: 9999 }),
    "sent",
    baseTime + 20.125,
    baseTime + 20.875,
  );
  message.run(
    "child-answer",
    "desktop-child",
    1,
    "assistant",
    JSON.stringify([
      { type: "reasoning_content", content: "Investigate", timestamp: baseTime + 30.125 },
      {
        type: "tool_call",
        status: "denied",
        timestamp: baseTime + 30.25,
        tool_call: { id: "bad", name: "execute", params: "opaque input", response: "failed" },
      },
      { type: "content", content: "Child complete", timestamp: baseTime + 30.5 },
    ]),
    JSON.stringify({
      model: "migration-fixture",
      provider: "fixture",
      inputTokens: 10,
      outputTokens: 3,
    }),
    "pending",
    baseTime + 30.125,
    baseTime + 30.75,
  );
  db.exec(
    "INSERT INTO deepchat_user_messages VALUES ('user','Read the attached file'); INSERT INTO deepchat_user_message_files VALUES ('user',0,'input.txt','input.txt'); INSERT INTO deepchat_user_message_links VALUES ('user',0,'https://example.com/reference');",
  );
  const block = db.prepare(
    "INSERT INTO deepchat_assistant_blocks (message_id,block_index,block_type,status,text_content,tool_call_id,tool_name,tool_params,tool_response,image_mime_type,extra_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  block.run(
    "answer",
    0,
    "reasoning_content",
    "success",
    "Checking",
    null,
    null,
    null,
    null,
    null,
    null,
    baseTime + 21.125,
  );
  block.run(
    "answer",
    1,
    "tool_call",
    "success",
    null,
    "read",
    "read_file",
    JSON.stringify({ path: "input.txt" }),
    "file body",
    null,
    JSON.stringify({ extra: { namespace: "fixture" } }),
    baseTime + 21.25,
  );
  block.run(
    "answer",
    2,
    "image",
    "success",
    null,
    null,
    null,
    null,
    null,
    "image/png",
    JSON.stringify({ imageData: "aGVsbG8=" }),
    baseTime + 21.5,
  );
  block.run(
    "answer",
    3,
    "content",
    "success",
    "File checked",
    null,
    null,
    null,
    null,
    null,
    null,
    baseTime + 21.75,
  );
  db.prepare("INSERT INTO deepchat_usage_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "usage-answer",
    "desktop-parent",
    "answer",
    "migration-fixture",
    "fixture",
    1300,
    200,
    1500,
    200,
    100,
    baseTime + 22.125,
    baseTime + 99.75,
  );
  db.prepare("INSERT INTO deepchat_usage_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "usage-compaction",
    "desktop-parent",
    null,
    "migration-fixture",
    "fixture",
    100,
    10,
    110,
    0,
    0,
    baseTime + 22.25,
    baseTime + 100.25,
  );
  db.close();
  return path;
}
function minimax(fixture) {
  const { db, path } = database(fixture, "minimax-code", "v2/sqlite/runtime-state.sqlite");
  db.prepare(
    "INSERT INTO local_runtime_sessions (session_id,title,workspace_dir,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)",
  ).run("desktop-parent", "", fixture.project, baseTime + 0.25, baseTime + 0.5);
  db.prepare(
    "INSERT INTO local_runtime_sessions (session_id,title,workspace_dir,parent_session_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?)",
  ).run(
    "desktop-child",
    "Child",
    fixture.project,
    "desktop-parent",
    baseTime + 0.375,
    baseTime + 0.75,
  );
  const insert = db.prepare(
    "INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,source,created_at_ms,data_json) VALUES (?,?,?,?,?,?,?)",
  );
  const message = (id, role, data, time, session = "desktop-parent", source = "user") =>
    insert.run(session, id, role, "turn", source, time, JSON.stringify({ msg_id: id, ...data }));
  message(
    "user",
    "user",
    {
      msg_content: "Review 中文 project",
      attachments: [
        { file_path: "input.txt", mime_type: "text/plain" },
        { url: "https://example.com/image.png", mime_type: "image/png" },
      ],
    },
    baseTime + 10.125,
  );
  message(
    "tools",
    "assistant",
    {
      thinking_content: "Inspect source",
      tool_calls: [
        {
          tool_name: "read",
          tool_call_id: "read",
          tool_call_status: 2,
          tool_call_args: JSON.stringify({ path: "input.txt" }),
          tool_call_result_data: JSON.stringify({ text: "file body" }),
        },
        {
          tool_name: "task",
          tool_call_id: "task",
          tool_call_status: 3,
          tool_call_args: "opaque input",
          tool_call_result_data: JSON.stringify({
            error: "failure",
            details: { sub_session_id: "desktop-child" },
          }),
        },
      ],
    },
    baseTime + 20.25,
  );
  message(
    "answer",
    "assistant",
    { msg_content: "Looks good", finish_reason: "stop" },
    baseTime + 20.5,
  );
  message("compact", "assistant", { kind: "compaction" }, baseTime + 21.125);
  message(
    "automated",
    "user",
    { msg_content: "Scheduled follow-up" },
    baseTime + 21.75,
    "desktop-parent",
    "cron",
  );
  message(
    "child-answer",
    "assistant",
    { msg_content: "Child report", finish_reason: "stop" },
    baseTime + 22.25,
    "desktop-child",
  );
  db.prepare(
    "INSERT INTO local_runtime_token_usage (session_id,turn_id,model,ts,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "desktop-parent",
    "turn",
    "migration-fixture",
    baseTime + 22.625,
    100,
    20,
    5,
    40,
    10,
    0.025,
  );
  db.prepare(
    "INSERT INTO local_runtime_token_usage (session_id,turn_id,model,ts,input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,?)",
  ).run("desktop-parent", "turn", "migration-fixture", baseTime + 22.875, 50, 10, 0);
  db.close();
  return path;
}
function cherry(fixture) {
  const { db, path } = database(fixture, "cherrystudio", "Data/cherrystudio.sqlite");
  db.prepare("UPDATE agent_workspace SET path=?").run(fixture.project);
  db.prepare(
    "INSERT INTO agent_session (id,name,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?)",
  ).run("desktop", "Review project", baseTime + 0.125, baseTime + 1.25, baseTime + 30.75);
  db.prepare(
    "INSERT INTO topic (id,name,active_node_id,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?)",
  ).run("branch", "Topic 中文", "chosen", baseTime + 0.375, baseTime + 1.5, baseTime + 31.125);
  const agentMessage = db.prepare(
    "INSERT INTO agent_session_message (id,session_id,role,data,stats,model_id,message_snapshot,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  agentMessage.run(
    "user",
    "desktop",
    "user",
    JSON.stringify({
      parts: [
        { type: "text", text: "Read source" },
        { type: "file", filename: "input.txt", url: "file:///input.txt", mediaType: "text/plain" },
        { type: "file", url: "https://example.com/image.png", mediaType: "image/png" },
      ],
    }),
    null,
    null,
    null,
    "success",
    baseTime + 10.125,
    baseTime + 10.625,
  );
  agentMessage.run(
    "assistant",
    "desktop",
    "assistant",
    JSON.stringify({
      parts: [
        { type: "reasoning", text: "<system-reminder>hidden</system-reminder>Check source" },
        {
          type: "tool-read",
          toolCallId: "read",
          title: "Read file",
          state: "output-available",
          input: { path: "input.txt" },
          output: "file body",
        },
        {
          type: "dynamic-tool",
          toolName: "execute",
          toolCallId: "denied",
          state: "output-denied",
          errorText: "Permission denied",
          input: { cmd: "echo hello" },
        },
        { type: "text", text: "Completed" },
        { type: "data-code", data: { content: "export const value = 1" } },
      ],
    }),
    JSON.stringify({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 10 },
      outputTokenDetails: { reasoningTokens: 5 },
      costs: [{ currency: "USD", amount: 0.015, computedRequestCount: 1 }],
    }),
    "fixture::migration-fixture",
    JSON.stringify({
      name: "Review agent",
      model: { id: "migration-fixture", provider: "fixture" },
    }),
    "success",
    baseTime + 20.25,
    baseTime + 20.875,
  );
  const topicMessage = db.prepare(
    "INSERT INTO message (id,topic_id,parent_id,role,data,stats,model_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  topicMessage.run(
    "question",
    "branch",
    null,
    "user",
    JSON.stringify({ parts: [{ type: "text", text: "Explain source" }] }),
    null,
    null,
    "success",
    baseTime + 11.125,
    baseTime + 11.375,
  );
  topicMessage.run(
    "chosen",
    "branch",
    "question",
    "assistant",
    JSON.stringify({ parts: [{ type: "text", text: "Chosen answer" }] }),
    JSON.stringify({ inputTokens: 10, outputTokens: 3 }),
    "fixture::migration-fixture",
    "pending",
    baseTime + 21.375,
    baseTime + 21.625,
  );
  topicMessage.run(
    "discarded",
    "branch",
    "question",
    "assistant",
    "{broken",
    null,
    null,
    "success",
    baseTime + 22.25,
    baseTime + 22.5,
  );
  db.close();
  return path;
}
async function serve(fixture, agent, command) {
  const process = launch(
    fixture,
    ["--agent", agent, "--days", "0", "--noOpen", "--host", "127.0.0.1", "--port", "0"],
    command,
  );
  try {
    const startup = await waitFor(() => {
      assert.equal(process.child.exitCode, null, JSON.stringify(process.output()));
      return [...process.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((m) => new URL(m[0]))
        .find((url) => url.searchParams.has("access_token"));
    }, "desktop HTTP startup");
    startup.hostname = "127.0.0.1";
    const request = (path) =>
      fetch(new URL(path, startup.origin), {
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${startup.searchParams.get("access_token")}` },
      });
    await waitFor(async () => {
      const response = await request("/api/status");
      const status = await response.json();
      return !status.active && status.completedAgents.includes(agent);
    }, "desktop scan completion");
    return { ...process, request };
  } catch (error) {
    await stop(process);
    throw new Error(`${error.message}\n${JSON.stringify(process.output())}`, { cause: error });
  }
}
function clearCache(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
}
async function collect(server, agent) {
  const list = await readJson(server, "/api/sessions");
  assert.ok(list.sessions.length >= 2);
  const details = [];
  for (const session of list.sessions) {
    assert.equal(session.reference.agentName, agent);
    const path = `/api/sessions/${agent}/${encodeURIComponent(session.reference.sessionId)}`;
    const detail = await readJson(server, path);
    assert.ok(detail.message_cursor);
    const unchanged = await readJson(
      server,
      `${path}?messageCursor=${encodeURIComponent(detail.message_cursor)}`,
    );
    const reset = await readJson(server, `${path}?messageCursor=invalid`);
    details.push({ detail, unchanged, reset });
  }
  return { list, details };
}
for (const [agent, setup] of [
  ["deepchat", deepchat],
  ["cherrystudio", cherry],
  ["minimax-code", minimax],
]) {
  test(`${agent}: complete Node/Rust HTTP payloads and message cursors preserve fractional timestamps`, async () => {
    const fixture = createFixture();
    let server;
    writeFileSync(
      join(fixture.root, ".cache/codesesh/models-dev-pricing.json"),
      JSON.stringify({
        timestamp: Date.now(),
        data: {
          "migration-fixture": { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002 },
        },
      }),
    );
    const source = setup(fixture);
    const before = readFileSync(source);
    try {
      server = await serve(fixture, agent, reference);
      const expected = await collect(server, agent);
      await stop(server);
      server = undefined;
      assert.equal(
        expected.list.sessions.some((s) => s.time_created % 1 !== 0),
        true,
      );
      clearCache(fixture);
      server = await serve(fixture, agent, rust);
      const actual = await collect(server, agent);
      await stop(server);
      server = undefined;
      assert.deepEqual(actual, expected);
      server = await serve(fixture, agent, rust);
      assert.deepEqual(await collect(server, agent), expected);
      assert.deepEqual(readFileSync(source), before);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  });
}
