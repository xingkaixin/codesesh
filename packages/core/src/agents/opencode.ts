import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, resolveDataHome } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";
import type { AgentSourceOptions } from "./base.js";

const AGENT_METADATA = getAgentCatalogEntry("opencode");

export function resolveOpenCodeDataRoot(): string {
  return join(resolveDataHome(), "opencode");
}

function findOpenCodeDbPath(sourceRoot?: string): string | null {
  if (!isSqliteAvailable()) return null;
  if (sourceRoot) return firstExisting(join(sourceRoot, "opencode.db"));
  return firstExisting(join(resolveOpenCodeDataRoot(), "opencode.db"), "data/opencode/opencode.db");
}

function getOpenCodeSessionWatchPlan(sourceRoot?: string) {
  const dataRoot = sourceRoot ?? resolveOpenCodeDataRoot();
  return {
    status: "supported" as const,
    targets: sourceRoot
      ? [{ root: dataRoot, path: join(dataRoot, "opencode.db") }]
      : [
          { root: dataRoot, path: join(dataRoot, "opencode.db") },
          { root: "data/opencode", path: "data/opencode/opencode.db" },
        ],
  };
}

export class OpenCodeAgent extends OpenCodeSqliteAgent {
  constructor(options: AgentSourceOptions = {}) {
    super({
      name: AGENT_METADATA.name,
      displayName: AGENT_METADATA.displayName,
      findDbPath: () => findOpenCodeDbPath(options.sourceRoot),
      getSessionWatchPlan: () => getOpenCodeSessionWatchPlan(options.sourceRoot),
    });
  }
}
