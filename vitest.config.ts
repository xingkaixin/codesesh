import { defineConfig } from "vitest/config";

const COVERAGE_THRESHOLD_SCOPE =
  "{packages/core/src/utils/**,packages/core/src/discovery/**,packages/core/src/agents/base.ts,packages/cli/src/api/**}";

export default defineConfig({
  test: {
    projects: ["packages/core", "packages/cli", "apps/web"],
    coverage: {
      provider: "v8",
      exclude: ["**/node_modules/**", "**/dist/**", "packages/core/src/utils/sqlite.ts"],
      reporter: ["text", "html"],
      thresholds: {
        [COVERAGE_THRESHOLD_SCOPE]: {
          lines: 75,
        },
      },
    },
  },
});
