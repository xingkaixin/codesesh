/// <reference types="node" />
import { defineConfig } from "tsup";

const isWatch = process.argv.includes("--watch");

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime/agents.ts",
    "src/runtime/analytics.ts",
    "src/runtime/diagnostics.ts",
    "src/runtime/discovery.ts",
    "src/runtime/pricing.ts",
    "src/runtime/projects.ts",
    "src/runtime/search.ts",
    "src/runtime/state.ts",
    "src/contract/index.ts",
    "src/repository-facts.ts",
    "src/test-fixtures.ts",
  ],
  format: ["esm", "cjs"],
  dts: false,
  clean: !isWatch,
  sourcemap: true,
  outExtension({ format }) {
    return format === "esm" ? { js: ".mjs" } : { js: ".js" };
  },
});
