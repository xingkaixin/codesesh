import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_COVERAGE_SCOPES = [
  {
    id: "core-boundaries",
    owners: [
      { path: "packages/core/src/utils", kind: "directory" },
      { path: "packages/core/src/discovery", kind: "directory" },
      { path: "packages/core/src/agents/base.ts", kind: "file" },
      {
        path: "packages/core/src/agents/session-source-synchronization.ts",
        kind: "file",
      },
      { path: "packages/cli/src/api", kind: "directory" },
    ],
    thresholds: { lines: 90 },
  },
  {
    id: "agent-adapters",
    owners: [{ path: "packages/core/src/agents", kind: "directory" }],
    thresholds: { lines: 86 },
  },
  {
    id: "cli-runtime",
    owners: [
      { path: "packages/cli/src/agent-operation-scheduler.ts", kind: "file" },
      { path: "packages/cli/src/agent-sync-engine.ts", kind: "file" },
      { path: "packages/cli/src/backfill-lifecycle.ts", kind: "file" },
      { path: "packages/cli/src/live-scan.ts", kind: "file" },
      { path: "packages/cli/src/live-session-index.ts", kind: "file" },
      { path: "packages/cli/src/pending-search-index-jobs.ts", kind: "file" },
      { path: "packages/cli/src/scan-refresh-operation.ts", kind: "file" },
      { path: "packages/cli/src/scan-refresh-worker.ts", kind: "file" },
      { path: "packages/cli/src/scan-status-model.ts", kind: "file" },
      { path: "packages/cli/src/search-index-job-runner.ts", kind: "file" },
      { path: "packages/cli/src/search-index-worker.ts", kind: "file" },
      { path: "packages/cli/src/session-watcher.ts", kind: "file" },
      { path: "packages/cli/src/smart-tag-worker.ts", kind: "file" },
      { path: "packages/cli/src/worker-runner.ts", kind: "file" },
    ],
    thresholds: { lines: 91 },
  },
  {
    id: "cli-runtime-plan",
    owners: [{ path: "packages/cli/src/runtime-plan.ts", kind: "file" }],
    thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
  {
    id: "web-hooks",
    owners: [{ path: "apps/web/src/hooks", kind: "directory" }],
    thresholds: { lines: 95 },
  },
  {
    // The browser↔server boundary: a regression here breaks every surface at
    // once, and it is the highest-churn web module outside App.tsx.
    id: "web-api-client",
    owners: [
      { path: "apps/web/src/lib/api.ts", kind: "file" },
      { path: "apps/web/src/lib/session-detail-cache.ts", kind: "file" },
      { path: "apps/web/src/lib/session-query-consistency.ts", kind: "file" },
    ],
    thresholds: { lines: 89 },
  },
  {
    id: "web-interactions",
    owners: [
      { path: "apps/web/src/components/overview/OverviewScreen.tsx", kind: "file" },
      { path: "apps/web/src/components/app/SearchResultsPanel.tsx", kind: "file" },
      { path: "apps/web/src/components/session-detail/message-list.tsx", kind: "file" },
      {
        path: "apps/web/src/components/session-detail/session-message-timeline.tsx",
        kind: "file",
      },
    ],
    thresholds: { lines: 87 },
  },
  {
    id: "web-route-recovery",
    owners: [
      { path: "apps/web/src/router.tsx", kind: "file" },
      { path: "apps/web/src/components/app/AppRouteContent.tsx", kind: "file" },
      { path: "apps/web/src/components/DetailLanding.tsx", kind: "file" },
    ],
    thresholds: { lines: 85 },
  },
];

function ownerPattern(owner) {
  return owner.kind === "directory" ? `${owner.path}/**` : owner.path;
}

export function getCoverageScopePattern(scope) {
  const patterns = scope.owners.map(ownerPattern);
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

export function getCriticalCoverageThresholds(scopes = CRITICAL_COVERAGE_SCOPES) {
  return Object.fromEntries(
    scopes.map((scope) => [getCoverageScopePattern(scope), scope.thresholds]),
  );
}

function isProductionSource(path) {
  const normalized = path.split(sep).join("/");
  return (
    /\.(?:ts|tsx)$/.test(normalized) &&
    !/\.test\.(?:ts|tsx)$/.test(normalized) &&
    !normalized.includes("/__tests__/") &&
    !normalized.endsWith(".d.ts")
  );
}

function listProductionSources(root, path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...listProductionSources(root, child));
    else if (entry.isFile() && isProductionSource(child)) {
      files.push(relative(root, child).split(sep).join("/"));
    }
  }
  return files;
}

export function inspectCriticalCoverageOwners(repoRoot, scopes = CRITICAL_COVERAGE_SCOPES) {
  const gaps = [];
  const matches = new Map();

  for (const scope of scopes) {
    const scopeMatches = [];
    for (const owner of scope.owners) {
      const absolutePath = join(repoRoot, owner.path);
      if (!existsSync(absolutePath)) {
        gaps.push(`${scope.id}: owner does not exist: ${owner.path}`);
        continue;
      }

      const stat = statSync(absolutePath);
      if (owner.kind === "file") {
        if (!stat.isFile()) gaps.push(`${scope.id}: expected file owner: ${owner.path}`);
        else if (!isProductionSource(owner.path)) {
          gaps.push(`${scope.id}: owner is not a production TypeScript file: ${owner.path}`);
        } else scopeMatches.push(owner.path);
        continue;
      }

      if (!stat.isDirectory()) {
        gaps.push(`${scope.id}: expected directory owner: ${owner.path}`);
        continue;
      }

      const directoryMatches = listProductionSources(repoRoot, absolutePath);
      if (directoryMatches.length === 0) {
        gaps.push(`${scope.id}: directory owner matches no production files: ${owner.path}`);
      }
      scopeMatches.push(...directoryMatches);
    }

    const uniqueMatches = [...new Set(scopeMatches)].sort();
    if (uniqueMatches.length === 0) gaps.push(`${scope.id}: scope matches no production files`);
    matches.set(scope.id, uniqueMatches);
  }

  return { gaps, matches };
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = inspectCriticalCoverageOwners(repoRoot);
  if (result.gaps.length > 0) {
    console.error("Critical coverage owner validation failed:");
    for (const gap of result.gaps) console.error(`  - ${gap}`);
    process.exitCode = 1;
    return;
  }

  console.log("Critical coverage owners:");
  for (const [scope, files] of result.matches) {
    console.log(`  ${scope} (${files.length})`);
    for (const file of files) console.log(`    - ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
