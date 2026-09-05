import assert from "node:assert/strict";
import { createSessionProjectionContext } from "../packages/core/dist/contract/index.mjs";

function session(index, parent) {
  return {
    reference: { agentName: "codex", sessionId: String(index) },
    parent_reference:
      parent == null ? undefined : { agentName: "codex", sessionId: String(parent) },
    time_created: index,
    stats: { message_count: 1, total_input_tokens: 1, total_output_tokens: 1 },
    title: String(index),
    directory: "/benchmark",
  };
}

for (const shape of ["chain", "wide"]) {
  for (const size of [500, 2_000, 8_000]) {
    const sessions = Array.from({ length: size }, (_, index) =>
      session(index, index === 0 ? null : shape === "chain" ? index - 1 : 0),
    );
    const changes = sessions.slice(1).map((item) => ({ reference: item.reference, session: item }));
    const run = () => createSessionProjectionContext(sessions, sessions, changes, []);
    run();
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const start = performance.now();
      const result = run();
      samples.push(performance.now() - start);
      assert.deepEqual(
        result.relatedSessionHeads.map((item) => item.reference.sessionId),
        ["0"],
      );
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ shape, size, medianMs: Number(samples[1].toFixed(3)) }));
  }
}
