import assert from "node:assert/strict";
import { filterSessionTreeByActivityWindow } from "../packages/core/dist/contract/index.mjs";

for (const size of [1_000, 10_000, 50_000]) {
  const sessions = Array.from({ length: size }, (_, index) => ({
    reference: { agentName: "codex", sessionId: String(index) },
    parent_reference:
      index % 5 ? { agentName: "codex", sessionId: String(index - (index % 5)) } : undefined,
    time_created: index,
    stats: { message_count: 1, total_input_tokens: 1, total_output_tokens: 1 },
    title: String(index),
    directory: "/benchmark",
  }));
  for (const mode of ["unbounded", "all-time", "partial"]) {
    const from = mode === "partial" ? size / 2 : mode === "all-time" ? 0 : undefined;
    const run = () => filterSessionTreeByActivityWindow(sessions, from);
    run();
    const samples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = performance.now();
      for (let iteration = 0; iteration < 20; iteration++) {
        const result = run();
        if (mode === "unbounded") assert.equal(result, sessions);
        else assert.equal(result.length, mode === "partial" ? size / 2 : size);
      }
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ size, mode, calls: 20, medianMs: Number(samples[2].toFixed(3)) }));
  }
}
