import { defineConfig } from "vitest/config";
import { getCriticalCoverageThresholds } from "./scripts/critical-coverage.mjs";

const CONTRACT_SOURCE_SCOPE = "packages/contract/src/**/*.ts";
const WEB_SOURCE_SCOPE = "apps/web/src/**/*.{ts,tsx}";
export default defineConfig({
  test: {
    projects: [
      "packages/contract",
      "apps/web",
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          exclude: ["scripts/rust/**"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [CONTRACT_SOURCE_SCOPE, WEB_SOURCE_SCOPE],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        [CONTRACT_SOURCE_SCOPE]: {
          statements: 79,
          branches: 66,
          functions: 89,
          lines: 82,
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
