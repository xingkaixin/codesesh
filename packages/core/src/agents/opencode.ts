import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, resolveDataHome } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";

const AGENT_METADATA = getAgentCatalogEntry("opencode");

export function resolveOpenCodeDataRoot(): string {
  return join(resolveDataHome(), "opencode");
}

function findOpenCodeDbPath(): string | null {
  if (!isSqliteAvailable()) return null;
  return firstExisting(join(resolveOpenCodeDataRoot(), "opencode.db"), "data/opencode/opencode.db");
}

function getOpenCodeSessionWatchPlan() {
  const dataRoot = resolveOpenCodeDataRoot();
  return {
    status: "supported" as const,
    targets: [
      { root: dataRoot, path: join(dataRoot, "opencode.db") },
      { root: "data/opencode", path: "data/opencode/opencode.db" },
    ],
  };
}

export class OpenCodeAgent extends OpenCodeSqliteAgent {
  constructor() {
    super({
      name: AGENT_METADATA.name,
      displayName: AGENT_METADATA.displayName,
      findDbPath: findOpenCodeDbPath,
      getSessionWatchPlan: getOpenCodeSessionWatchPlan,
    });
  }
}
