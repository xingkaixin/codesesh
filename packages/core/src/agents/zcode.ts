import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";
import type { AgentSourceOptions } from "./base.js";

const AGENT_METADATA = getAgentCatalogEntry("zcode");

export function resolveZCodeDataRoot(): string | null {
  const currentPlatform = platform();
  if (currentPlatform !== "darwin" && currentPlatform !== "win32") return null;
  return join(homedir(), ".zcode");
}

function findZCodeDbPath(sourceRoot?: string): string | null {
  if (!isSqliteAvailable()) return null;
  const dataRoot = sourceRoot ?? resolveZCodeDataRoot();
  if (!dataRoot) return null;
  return firstExisting(join(dataRoot, "cli", "db", "db.sqlite"));
}

function getZCodeSessionWatchPlan(sourceRoot?: string) {
  const dataRoot = sourceRoot ?? resolveZCodeDataRoot();
  return {
    status: "supported" as const,
    targets: dataRoot ? [{ root: dataRoot, path: join(dataRoot, "cli", "db", "db.sqlite") }] : [],
  };
}

export class ZCodeAgent extends OpenCodeSqliteAgent {
  constructor(options: AgentSourceOptions = {}) {
    super({
      name: AGENT_METADATA.name,
      displayName: AGENT_METADATA.displayName,
      findDbPath: () => findZCodeDbPath(options.sourceRoot),
      getSessionWatchPlan: () => getZCodeSessionWatchPlan(options.sourceRoot),
    });
  }
}
