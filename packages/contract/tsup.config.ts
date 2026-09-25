import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/test-fixtures.ts"],
  format: ["esm", "cjs"],
  dts: false,
  clean: !process.argv.includes("--watch"),
  sourcemap: true,
  outExtension({ format }) {
    return format === "esm" ? { js: ".mjs" } : { js: ".js" };
  },
});
