import { defineConfig } from "tsup";

const isWatch = process.argv.includes("--watch");
const bundleCore = process.env.BUNDLE_CORE === "true";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: !isWatch,
  sourcemap: true,
  noExternal: bundleCore ? ["@agent-lens/core"] : [],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
