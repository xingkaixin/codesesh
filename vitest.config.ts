import { defineConfig } from "vitest/config";

const CORE_SOURCE_SCOPE = "packages/core/src/**/*.ts";
const CLI_SOURCE_SCOPE = "packages/cli/src/**/*.ts";
const WEB_SOURCE_SCOPE = "apps/web/src/**/*.{ts,tsx}";
const CORE_CRITICAL_SCOPE =
  "{packages/core/src/utils/**,packages/core/src/discovery/**,packages/core/src/agents/base.ts,packages/cli/src/api/**}";
const CLI_RUNTIME_SCOPE =
  "{packages/cli/src/live-scan.ts,packages/cli/src/session-watcher.ts,packages/cli/src/*-coordinator.ts,packages/cli/src/*-worker.ts,packages/cli/src/pending-search-index-jobs.ts,packages/cli/src/scan-status-model.ts}";
const CLI_RUNTIME_PLAN_SCOPE = "packages/cli/src/runtime-plan.ts";
const WEB_HOOKS_SCOPE = "apps/web/src/hooks/**";
const WEB_INTERACTIONS_SCOPE =
  "{apps/web/src/components/Dashboard.tsx,apps/web/src/components/app/SearchResultsPanel.tsx,apps/web/src/components/session-detail/message-list.tsx,apps/web/src/components/session-detail/session-message-timeline.tsx}";

export default defineConfig({
  test: {
    projects: ["packages/core", "packages/cli", "apps/web"],
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
        [CORE_CRITICAL_SCOPE]: {
          lines: 90,
        },
        [CLI_RUNTIME_SCOPE]: {
          lines: 91,
        },
        [CLI_RUNTIME_PLAN_SCOPE]: {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        [WEB_HOOKS_SCOPE]: {
          lines: 95,
        },
        [WEB_INTERACTIONS_SCOPE]: {
          lines: 87,
        },
      },
    },
  },
});
