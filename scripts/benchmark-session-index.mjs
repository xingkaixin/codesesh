import { performance } from "node:perf_hooks";
import { applySessionChanges, createSessionIndex } from "../packages/core/dist/contract/index.mjs";

const sessionCount = Number(process.env.SESSION_INDEX_BENCH_SIZE ?? 25_000);
const changeCount = Number(process.env.SESSION_INDEX_BENCH_CHANGES ?? 100);
const sessions = Array.from({ length: sessionCount }, (_, index) => ({
  id: `session-${index}`,
  slug: `${index % 2 === 0 ? "codex" : "claude"}/session-${index}`,
  title: `Session ${index}`,
  directory: `/workspace/${index % 200}`,
  project_identity: {
    kind: "path",
    key: `/workspace/${index % 200}`,
    displayName: `Project ${index % 200}`,
  },
  time_created: sessionCount - index,
  time_updated: sessionCount - index,
  stats: {
    message_count: 1,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
  },
}));
const changes = Array.from({ length: changeCount }, (_, index) => ({
  agentName: index % 2 === 0 ? "codex" : "claude",
  session: {
    ...sessions[index * 2],
    time_updated: sessionCount + index + 1,
  },
}));

function measure(run) {
  const durations = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const startedAt = performance.now();
    run();
    durations.push(performance.now() - startedAt);
  }
  return durations.toSorted((a, b) => a - b)[Math.floor(durations.length / 2)];
}

const canonicalMs = measure(() => {
  const updated = applySessionChanges(sessions, changes, []);
  createSessionIndex(updated);
});
const repeatedSortMs = measure(() => {
  const updated = applySessionChanges(sessions, changes, []);
  const redundantlySorted = [...updated].sort(
    (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
  );
  createSessionIndex(redundantlySorted);
});

console.log(
  JSON.stringify(
    {
      sessions: sessionCount,
      changes: changeCount,
      canonical_ms: Number(canonicalMs.toFixed(2)),
      repeated_sort_ms: Number(repeatedSortMs.toFixed(2)),
    },
    null,
    2,
  ),
);
