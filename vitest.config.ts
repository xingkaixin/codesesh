import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/utils/**",
        "!packages/core/src/utils/sqlite.ts",
        "packages/core/src/discovery/**",
        "packages/core/src/agents/base.ts",
        "packages/cli/src/api/**",
      ],
      exclude: ["**/node_modules/**", "**/dist/**", "packages/core/src/utils/sqlite.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 75,
      },
    },
  },
});
