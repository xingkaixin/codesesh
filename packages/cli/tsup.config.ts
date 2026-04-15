import { defineConfig } from "tsup";

const isWatch = process.argv.includes("--watch");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: !isWatch,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
