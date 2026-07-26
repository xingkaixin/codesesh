import { join } from "node:path";
import { firstExisting, resolveProviderRoots } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";

function findZCodeDbPath(): string | null {
  if (!isSqliteAvailable()) return null;
  const roots = resolveProviderRoots();
  if (!roots.zcodeRoot) return null;
  return firstExisting(join(roots.zcodeRoot, "cli", "db", "db.sqlite"));
}

function getZCodeSessionWatchPlan() {
  const roots = resolveProviderRoots();
  return {
    status: "supported" as const,
    targets: roots.zcodeRoot
      ? [{ root: roots.zcodeRoot, path: join(roots.zcodeRoot, "cli", "db", "db.sqlite") }]
      : [],
  };
}

export class ZCodeAgent extends OpenCodeSqliteAgent {
  constructor() {
    super({
      name: "zcode",
      displayName: "ZCode",
      findDbPath: findZCodeDbPath,
      getSessionWatchPlan: getZCodeSessionWatchPlan,
    });
  }
}
