import { join } from "node:path";
import { firstExisting, resolveAgentRoots } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";

function findOpenCodeDbPath(): string | null {
  if (!isSqliteAvailable()) return null;
  const roots = resolveAgentRoots();
  return firstExisting(join(roots.opencodeRoot, "opencode.db"), "data/opencode/opencode.db");
}

function getOpenCodeSessionWatchPlan() {
  const roots = resolveAgentRoots();
  return {
    status: "supported" as const,
    targets: [
      { root: roots.opencodeRoot, path: join(roots.opencodeRoot, "opencode.db") },
      { root: "data/opencode", path: "data/opencode/opencode.db" },
    ],
  };
}

export class OpenCodeAgent extends OpenCodeSqliteAgent {
  constructor() {
    super({
      name: "opencode",
      displayName: "OpenCode",
      findDbPath: findOpenCodeDbPath,
      getSessionWatchPlan: getOpenCodeSessionWatchPlan,
    });
  }
}
