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

for (const scenario of ["plain", "usage", "plan", "tools", "patch", "exec", "notification", "child"]) {
  test(`Rust Codex CLI and HTTP slice match the frozen Node reference (${scenario})`, async () => {
    const fixture = createFixture();
    let server;
    if (scenario === "usage") {
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
    if (scenario === "plan" || scenario === "tools") {
      const payloads =
        scenario === "plan"
          ? [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "A proposal.\n<proposed_plan>Perform the change.</proposed_plan>",
                  },
                ],
              },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "PLEASE IMPLEMENT THIS PLAN" }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Done." }],
              },
            ]
          : [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Inspecting the response." }],
              },
              {
                type: "function_call",
                name: "lookup",
                namespace: "mcp__example",
                call_id: "tool-1",
                arguments: '{"query":"hello"}',
              },
              {
                type: "function_call_output",
                call_id: "tool-1",
                output: "Script completed\nWall time 0.1 seconds\nOutput:\nHello.",
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Finished." }],
              },
            ];
      appendFileSync(
        fixture.source,
        payloads
          .map((payload, index) =>
            JSON.stringify({
              timestamp: `2026-09-01T10:00:0${index + 4}Z`,
              type: "response_item",
              payload,
            }),
          )
          .join("\n") + "\n",
      );
    }
    if (["patch", "exec", "notification", "child"].includes(scenario)) {
      const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = 1;\n*** Update File: src/old.ts\n*** Move to: src/renamed.ts\n-old\n+new\n*** End Patch";
      const payloads = scenario === "notification" ? [{type:"message",role:"user",content:[{type:"input_text",text:'<subagent_notification>{"agent_id":"child-1","nickname":"Worker","completed":"Completed the work."}</subagent_notification>'}]}]
        : scenario === "child" ? [] : [
          {type:"custom_tool_call",name:scenario === "exec" ? "exec" : "apply_patch",call_id:"custom-1",input:scenario === "exec" ? `const patch = ${JSON.stringify(patch)}; await tools.apply_patch({patch}); await tools.exec_command({cmd: 'echo hello', timeout_ms: 1000});` : patch},
          {type:"custom_tool_call_output",call_id:"custom-1",output:"Script completed\nWall time 0.1 seconds\nOutput:\nDone."}
        ];
      appendFileSync(fixture.source, payloads.map((payload,index)=>JSON.stringify({timestamp:`2026-09-01T10:00:0${index+4}Z`,type:"response_item",payload})).join("\n")+"\n");
      if (scenario === "child") {
        const childSource = fixture.source.replace(/[^/\\]+$/, "rollout-2026-09-01T10-00-00-019fdefe-bb8d-76f3-b988-770e6cc6a30e.jsonl");
        const original = JSON.parse(readFileSync(fixture.source,"utf8").split("\n")[0]);
        original.payload.thread_source="subagent";
        original.payload.parent_thread_id="019fdefe-bb8d-76f3-b988-770e6cc6a30d";
        original.payload.agent_nickname="Worker";
        writeFileSync(childSource,[original,{timestamp:"2026-09-01T10:00:04Z",type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"Completed child work."}]}}].map(JSON.stringify).join("\n")+"\n");
      }
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
      const migrated = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.deepEqual(JSON.parse(migrated.stdout), JSON.parse(expected.stdout));
      server = await startServer(fixture, reference);
      assert.deepEqual(await readJson(server, DETAIL_PATH), expectedDetail);
      await stop(server);
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
