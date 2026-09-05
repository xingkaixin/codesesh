import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreRequire = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { build } = coreRequire("tsup");
const output = mkdtempSync(join(tmpdir(), "codesesh-pricing-benchmark-"));
try {
  await build({
    entry: Object.fromEntries(
      ["resolver", "fetcher"].map((name) => [
        name,
        fileURLToPath(new URL(`../packages/core/src/pricing/${name}.ts`, import.meta.url)),
      ]),
    ),
    format: ["esm"],
    splitting: true,
    config: false,
    outDir: output,
    outExtension: () => ({ js: ".mjs" }),
    silent: true,
  });
  const { pricingResolver } = await import(pathToFileURL(join(output, "resolver.mjs")));
  const { getPricingRegistry } = await import(pathToFileURL(join(output, "fetcher.mjs")));
  const registry = getPricingRegistry();
  const price = {
    inputCostPerToken: 1,
    outputCostPerToken: 2,
    cacheCreateCostPerToken: 1,
    cacheReadCostPerToken: 1,
    reasoningCostPerToken: 2,
    webSearchCostPerRequest: 0,
  };
  for (const size of [1_000, 10_000, 20_000]) {
    registry.clear();
    for (let index = 0; index < size; index++) registry.set(`bench-model-${index}`, price);
    for (const model of ["bench-model-7", "bench-model-7-thinking", "missing-model"]) {
      for (let index = 0; index < 100; index++) pricingResolver.resolve(model);
      const samples = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const started = performance.now();
        for (let index = 0; index < 1_000; index++) pricingResolver.resolve(model);
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      console.log(
        JSON.stringify({ size, model, lookups: 1_000, medianMs: Number(samples[2].toFixed(3)) }),
      );
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
