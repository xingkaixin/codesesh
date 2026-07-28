/**
 * Compares the canonical index build against a version that redundantly re-sorts.
 *
 * The budget is a ratio, not a wall-clock number: whatever the machine, doing
 * the work once must not cost more than doing it twice. An absolute millisecond
 * threshold would either be flaky on a loaded runner or too loose to catch
 * anything.
 */
import { performance } from "node:perf_hooks";
import { applySessionChanges, createSessionIndex } from "../packages/core/dist/contract/index.mjs";

/**
 * The canonical path must not cost more than redundantly re-sorting on top of
 * it. The two are close — a re-sort of already-sorted data is nearly linear —
 * so the budget allows for run-to-run noise rather than claiming a large win.
 * Complexity is covered by scripts/perf-scale.mjs, not by this ratio.
 */
const MAX_CANONICAL_RATIO = 1.05;

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
  reference: {
    agentName: index % 2 === 0 ? "codex" : "claude",
    sessionId: sessions[index * 2].id,
  },
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

const ratio = canonicalMs / repeatedSortMs;
const withinBudget = ratio <= MAX_CANONICAL_RATIO;

console.log(
  JSON.stringify(
    {
      sessions: sessionCount,
      changes: changeCount,
      canonical_ms: Number(canonicalMs.toFixed(2)),
      repeated_sort_ms: Number(repeatedSortMs.toFixed(2)),
      canonical_ratio: Number(ratio.toFixed(3)),
      budget: MAX_CANONICAL_RATIO,
      within_budget: withinBudget,
    },
    null,
    2,
  ),
);

if (!withinBudget) {
  console.error(
    `Canonical index build cost ${ratio.toFixed(2)}x the redundant one; expected at most ${MAX_CANONICAL_RATIO}.`,
  );
  process.exit(1);
}
