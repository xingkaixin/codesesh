import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, readEnvPath } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";
import type { AgentSourceOptions } from "./base.js";

const AGENT_METADATA = getAgentCatalogEntry("opencode");

export function resolveOpenCodeDataRoot(): string {
  return join(readEnvPath("XDG_DATA_HOME") ?? join(homedir(), ".local", "share"), "opencode");
}

function databasePaths(sourceRoot?: string): string[] {
  if (sourceRoot) return [join(sourceRoot, "opencode.db")];
  const configured = process.env.OPENCODE_DB?.trim();
  if (configured === ":memory:") return [];
  if (configured) return [resolve(resolveOpenCodeDataRoot(), configured)];
  return [join(resolveOpenCodeDataRoot(), "opencode.db"), "data/opencode/opencode.db"];
}

function getOpenCodeSessionWatchPlan(sourceRoot?: string) {
  return {
    status: "supported" as const,
    targets: databasePaths(sourceRoot).flatMap((path) =>
      ["", "-wal", "-journal"].map((suffix) => ({
        path: `${path}${suffix}`,
        pollForChanges: true,
      })),
    ),
  };
}

export class OpenCodeAgent extends OpenCodeSqliteAgent {
  constructor(options: AgentSourceOptions = {}) {
    super({
      name: AGENT_METADATA.name,
      displayName: AGENT_METADATA.displayName,
      findDbPath: () =>
        isSqliteAvailable() ? firstExisting(...databasePaths(options.sourceRoot)) : null,
      getSessionWatchPlan: () => getOpenCodeSessionWatchPlan(options.sourceRoot),
      supportsV2: true,
    });
  }
}
