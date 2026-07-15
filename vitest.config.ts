import { defineConfig } from "vitest/config";

const COVERAGE_THRESHOLD_SCOPE =
  "{packages/core/src/utils/**,packages/core/src/discovery/**,packages/core/src/agents/base.ts,packages/cli/src/api/**}";
const CLI_RUNTIME_SCOPE =
  "{packages/cli/src/live-scan.ts,packages/cli/src/session-watcher.ts,packages/cli/src/*-coordinator.ts,packages/cli/src/*-worker.ts,packages/cli/src/pending-search-index-jobs.ts,packages/cli/src/scan-status-model.ts}";
const WEB_HOOKS_SCOPE = "apps/web/src/hooks/**";
const WEB_INTERACTIONS_SCOPE =
  "{apps/web/src/components/Dashboard.tsx,apps/web/src/components/app/SearchResultsPanel.tsx,apps/web/src/components/session-detail/message-list.tsx,apps/web/src/components/session-detail/session-message-timeline.tsx}";

export default defineConfig({
  test: {
    projects: ["packages/core", "packages/cli", "apps/web"],
    coverage: {
      provider: "v8",
      include: [
        COVERAGE_THRESHOLD_SCOPE,
        CLI_RUNTIME_SCOPE,
        WEB_HOOKS_SCOPE,
        WEB_INTERACTIONS_SCOPE,
      ],
      exclude: ["**/node_modules/**", "**/dist/**", "packages/core/src/utils/sqlite.ts"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 88,
        branches: 80,
        functions: 88,
        lines: 91,
        [COVERAGE_THRESHOLD_SCOPE]: {
          lines: 90,
        },
        [CLI_RUNTIME_SCOPE]: {
          lines: 91,
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
