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
        owners: [{ path: "apps/web/src/removed-hook.ts", kind: "file" }],
        thresholds: { lines: 91 },
      },
    ]);

    expect(result.gaps).toEqual([
      "drifted-runtime: owner does not exist: apps/web/src/removed-hook.ts",
      "drifted-runtime: scope matches no production files",
    ]);
  });

  it("generates threshold keys from the same owner manifest", () => {
    expect(
      Object.fromEntries(CRITICAL_COVERAGE_SCOPES.map(({ id, thresholds }) => [id, thresholds])),
    ).toEqual({
      "web-hooks": { lines: 95 },
      "web-api-client": { lines: 89 },
      "web-interactions": { lines: 87 },
      "web-route-recovery": { lines: 85 },
    });
    for (const scope of CRITICAL_COVERAGE_SCOPES) {
      expect(getCriticalCoverageThresholds()).toHaveProperty(
        getCoverageScopePattern(scope),
        scope.thresholds,
      );
    }

    const routeRecovery = CRITICAL_COVERAGE_SCOPES.find(({ id }) => id === "web-route-recovery");
    if (!routeRecovery) throw new Error("web-route-recovery coverage scope is missing");
    expect(routeRecovery.owners.map(({ path }) => path)).toContain("apps/web/src/router.tsx");
  });
});
