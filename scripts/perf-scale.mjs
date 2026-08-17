/**
 * Growth-rate checks for algorithms whose cost must not scale super-linearly.
 *
 * A single timing at one N cannot tell O(N) from O(N²) — it only says the
 * machine was fast enough that day. Each case here runs several sizes and
 * compares the growth against a tolerance, so a regression shows up as a change
 * in shape rather than a threshold someone has to keep retuning.
 *
 * Deterministic gates (query counts, bundle bytes, cache cardinality) belong in
 * the unit tests next to the code they protect; this file covers the cases where
 * only the slope is meaningful.
 *
 * Usage: node scripts/perf-scale.mjs [--json]
 */
import { performance } from "node:perf_hooks";

/**
 * How much the per-item cost may grow when N quadruples. Linear work stays near
 * 1; quadratic work would be about 4. The allowance absorbs cache effects and a
 * loaded CI runner without letting a quadratic slip through.
 */
const MAX_COST_GROWTH = 2.5;

/** Sizes chosen so the largest is still fast when the algorithm is correct. */
const SIZES = [2_000, 8_000];
const CONTROL_SIZES = [400, 1_600];

/** Discards a warm-up run and reports the best of a few, to blunt scheduler noise. */
function measure(run, iterations = 3) {
  run();
  let best = Infinity;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    run();
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

/** Normalizes two duration samples by input size and applies the growth policy. */
function evaluateGrowth(name, sizes, durations) {
  const [small, large] = sizes;
  const [smallDuration, largeDuration] = durations;
  const smallCost = smallDuration / small;
  const largeCost = largeDuration / large;
  // A near-zero small measurement would make the ratio meaningless.
  const growth = smallCost > 0 ? largeCost / smallCost : 1;

  return {
    name,
    sizes,
    growth: Number(growth.toFixed(2)),
    limit: MAX_COST_GROWTH,
    ok: growth <= MAX_COST_GROWTH,
  };
}

function checkGrowth(name, run, sizes = SIZES) {
  return evaluateGrowth(
    name,
    sizes,
    sizes.map((size) => measure(() => run(size))),
  );
}

/** Allocates unique paths for labels that all collide — the sidebar's shape. */
function allocateCollidingPaths(size) {
  const used = new Set();
  const nextSuffix = new Map();
  for (let index = 0; index < size; index += 1) {
    const base = "Same title #deadbeef";
    if (!used.has(base)) {
      used.add(base);
      continue;
    }
    let suffix = nextSuffix.get(base) ?? 2;
    let candidate = `${base} (${suffix})`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base} (${suffix})`;
    }
    nextSuffix.set(base, suffix + 1);
    used.add(candidate);
  }
}

/** Records a height per item and reads offsets back — the transcript's shape. */
function measureEveryRow(size) {
  const tree = new Float64Array(size + 1);
  const add = (index, delta) => {
    for (let node = index + 1; node <= size; node += node & -node) tree[node] += delta;
  };
  const prefix = (count) => {
    let total = 0;
    for (let node = count; node > 0; node -= node & -node) total += tree[node];
    return total;
  };
  for (let index = 0; index < size; index += 1) add(index, 80 + (index % 400));
  let checksum = 0;
  for (let index = 0; index < size; index += 1) checksum += prefix(index);
  return checksum;
}

/** Groups rows by a key parsed from each — the per-session batch read's shape. */
function groupByOwner(size) {
  const rows = Array.from({ length: size }, (_, index) => ({
    key: `bubbleId:composer-${index % (size / 4)}:${index}`,
    value: index,
  }));
  const grouped = new Map();
  for (const row of rows) {
    const start = row.key.indexOf(":") + 1;
    const owner = row.key.slice(start, row.key.indexOf(":", start));
    const bucket = grouped.get(owner);
    if (bucket) bucket.push(row);
    else grouped.set(owner, [row]);
  }
  return grouped.size;
}

/** The former path allocator, used to prove the isolated gate detects O(N²). */
function allocateWithRestartedProbes(size) {
  const used = new Set();
  for (let index = 0; index < size; index += 1) {
    const base = "Same title #deadbeef";
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(path);
  }
}

const CASES = [
  ["sidebar path allocation over colliding labels", allocateCollidingPaths],
  ["virtual list height index over every row", measureEveryRow],
  ["grouping rows by their owning key", groupByOwner],
];

function main() {
  const asJson = process.argv.includes("--json");
  const results = CASES.map(([name, run]) => checkGrowth(name, run));
  const control = checkGrowth(
    "quadratic detection control",
    allocateWithRestartedProbes,
    CONTROL_SIZES,
  );
  const controlDetected = !control.ok;
  const growthRegressionDetected = results.some((result) => !result.ok);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          nodeVersion: process.version,
          maxCostGrowth: MAX_COST_GROWTH,
          control: { detected: controlDetected, measurement: control },
          results,
        },
        null,
        2,
      ),
    );
  } else {
    for (const result of results) {
      const status = result.ok ? "ok" : "FAIL";
      console.log(
        `${status.padEnd(5)} ${result.name}: per-item cost ×${result.growth} from ` +
          `${result.sizes[0]} to ${result.sizes[1]} items (limit ×${result.limit})`,
      );
    }
    const controlStatus = controlDetected ? "ok" : "FAIL";
    console.log(
      `${controlStatus.padEnd(5)} ${control.name}: observed per-item growth ×${control.growth} ` +
        `(must exceed ×${control.limit})`,
    );
  }

  if (!controlDetected) {
    console.error("\nGrowth-rate gate did not detect its quadratic control.");
  }
  if (growthRegressionDetected) {
    console.error("\nPer-item cost grew with input size: this shape is no longer linear.");
  }
  if (!controlDetected || growthRegressionDetected) process.exit(1);
}

export { CASES, MAX_COST_GROWTH, SIZES, checkGrowth, evaluateGrowth };

if (process.argv[1]?.endsWith("perf-scale.mjs")) main();
