/// <reference types="node" />
import { defineConfig } from "tsup";

const isWatch = process.argv.includes("--watch");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: !isWatch,
  sourcemap: true,
  outExtension({ format }) {
    return format === "esm" ? { js: ".mjs" } : { js: ".js" };
  },
});
