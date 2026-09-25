import { appendFileSync, mkdirSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFixture, SESSION_ID } from "../../harness.mjs";

export const IDS = [
  SESSION_ID,
  "019fdefe-bb8d-76f3-b988-770e6cc6a301",
  "019fdefe-bb8d-76f3-b988-770e6cc6a302",
];
export const BOOKMARK_TIME = 1_788_259_200_000;

export function createFullApiFixture() {
  const fixture = createFixture();
  const other = join(fixture.root, "another-project");
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(fixture.root, ".cache/codesesh/models-dev-pricing.json"),
    JSON.stringify({
      timestamp: Date.now(),
      data: { "migration-fixture": { inputCostPerToken: 0.001, outputCostPerToken: 0.002 } },
    }),
  );
  for (let index = 0; index < IDS.length; index++) {
    const id = IDS[index];
    const time = (second) => `2026-09-01T10:0${index}:${String(second).padStart(2, "0")}Z`;
    const records = [
      {
        timestamp: time(0),
        type: "session_meta",
        payload: { id, cwd: index === 2 ? other : fixture.project, model: "migration-fixture" },
      },
      {
        timestamp: time(1),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                index === 0
                  ? "Fix widget regression 中文 🔎"
                  : index === 1
                    ? "Document migration notes"
                    : "Explore other project",
            },
          ],
        },
      },
      {
        timestamp: time(2),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `🔎 sharedneedle response ${index}. migration-needle exact phrase.`,
            },
          ],
        },
      },
      {
        timestamp: time(3),
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: `patch-${index}`,
          input: `*** Begin Patch\n*** Add File: src/Widget${index}.ts\n+export const value = ${index};\n*** End Patch`,
        },
      },
      {
        timestamp: time(4),
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: `patch-${index}`, output: "Done." },
      },
      {
        timestamp: time(5),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20 + index,
              output_tokens: 7 + index,
              total_tokens: 27 + 2 * index,
            },
            last_token_usage: {
              input_tokens: 20 + index,
              output_tokens: 7 + index,
              total_tokens: 27 + 2 * index,
            },
          },
        },
      },
    ];
    const path =
      index === 0
        ? fixture.source
        : join(dirname(fixture.source), `rollout-2026-09-01T10-0${index}-00-${id}.jsonl`);
    writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
    utimesSync(path, new Date(time(6)), new Date(time(6)));
  }
  return { ...fixture, other };
}

export function resetBackendData(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
  rmSync(fixture.env.CODESESH_STATE_DIR, { recursive: true, force: true });
}

export function appendFullApiMessage(fixture) {
  appendFileSync(
    fixture.source,
    JSON.stringify({
      timestamp: "2026-09-01T10:05:00Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Live append after cursor capture" }],
      },
    }) + "\n",
  );
}
