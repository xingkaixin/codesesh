import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_COVERAGE_SCOPES,
  getCoverageScopePattern,
  getCriticalCoverageThresholds,
  inspectCriticalCoverageOwners,
} from "./critical-coverage.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("critical coverage owners", () => {
  it("resolves every declared owner to production files", () => {
    const result = inspectCriticalCoverageOwners(repoRoot);

    expect(result.gaps).toEqual([]);
    for (const scope of CRITICAL_COVERAGE_SCOPES) {
      expect(result.matches.get(scope.id)?.length).toBeGreaterThan(0);
    }
    expect([...result.matches.values()].flat().some((path) => path.includes("/__tests__/"))).toBe(
      false,
    );
  });

  it("fails with the scope and path when an owner drifts", () => {
    const result = inspectCriticalCoverageOwners(repoRoot, [
      {
        id: "drifted-runtime",
        owners: [{ path: "packages/cli/src/removed-coordinator.ts", kind: "file" }],
        thresholds: { lines: 91 },
      },
    ]);

    expect(result.gaps).toEqual([
      "drifted-runtime: owner does not exist: packages/cli/src/removed-coordinator.ts",
      "drifted-runtime: scope matches no production files",
    ]);
  });

  it("generates threshold keys from the same owner manifest", () => {
    const runtime = CRITICAL_COVERAGE_SCOPES.find(({ id }) => id === "cli-runtime");
    if (!runtime) throw new Error("cli-runtime coverage scope is missing");
    expect(runtime.owners.map(({ path }) => path)).toContain(
      "packages/cli/src/agent-sync-engine.ts",
    );
    expect(getCoverageScopePattern(runtime)).not.toContain("coordinator");
    expect(getCriticalCoverageThresholds()).toHaveProperty(getCoverageScopePattern(runtime), {
      lines: 91,
    });

    const adapters = CRITICAL_COVERAGE_SCOPES.find(({ id }) => id === "agent-adapters");
    if (!adapters) throw new Error("agent-adapters coverage scope is missing");
    expect(adapters.owners).toEqual([{ path: "packages/core/src/agents", kind: "directory" }]);
    expect(getCriticalCoverageThresholds()).toHaveProperty(getCoverageScopePattern(adapters), {
      lines: 86,
    });

    const routeRecovery = CRITICAL_COVERAGE_SCOPES.find(({ id }) => id === "web-route-recovery");
    if (!routeRecovery) throw new Error("web-route-recovery coverage scope is missing");
    expect(routeRecovery.owners.map(({ path }) => path)).toContain("apps/web/src/router.tsx");
  });
});
