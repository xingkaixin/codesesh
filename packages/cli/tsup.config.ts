import { defineConfig } from "tsup";

const isWatch = process.argv.includes("--watch");
const bundleCore = process.env.BUNDLE_CORE === "true";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/project-identity-worker.ts",
    "src/session-detail-worker.ts",
    "src/search-index-worker.ts",
    "src/scan-refresh-worker.ts",
    "src/smart-tag-worker.ts",
  ],
  format: ["esm"],
  dts: false,
  clean: !isWatch,
  sourcemap: true,
  noExternal: bundleCore ? [/^@codesesh\/core(?:\/.*)?$/] : [],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
