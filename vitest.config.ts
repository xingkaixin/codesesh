import { defineConfig } from "vitest/config";
import { getCriticalCoverageThresholds } from "./scripts/critical-coverage.mjs";

const CORE_SOURCE_SCOPE = "packages/core/src/**/*.ts";
const CLI_SOURCE_SCOPE = "packages/cli/src/**/*.ts";
const WEB_SOURCE_SCOPE = "apps/web/src/**/*.{ts,tsx}";
export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/cli",
      "apps/web",
      { test: { name: "scripts", include: ["scripts/**/*.test.mjs"] } },
    ],
    coverage: {
      provider: "v8",
      include: [CORE_SOURCE_SCOPE, CLI_SOURCE_SCOPE, WEB_SOURCE_SCOPE],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 70,
        branches: 59,
        functions: 74,
        lines: 72,
        [CORE_SOURCE_SCOPE]: {
          statements: 79,
          branches: 66,
          functions: 89,
          lines: 82,
        },
        [CLI_SOURCE_SCOPE]: {
          statements: 85,
          branches: 82,
          functions: 85,
          lines: 87,
        },
        [WEB_SOURCE_SCOPE]: {
          statements: 55,
          branches: 45,
          functions: 58,
          lines: 56,
        },
        ...getCriticalCoverageThresholds(),
      },
    },
  },
});
