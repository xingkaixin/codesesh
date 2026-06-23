import { join } from "node:path";
import { firstExisting, resolveProviderRoots } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";

function findOpenCodeDbPath(): string | null {
  if (!isSqliteAvailable()) return null;
  const roots = resolveProviderRoots();
  return firstExisting(join(roots.opencodeRoot, "opencode.db"), "data/opencode/opencode.db");
}

export class OpenCodeAgent extends OpenCodeSqliteAgent {
  constructor() {
    super({
      name: "opencode",
      displayName: "OpenCode",
      findDbPath: findOpenCodeDbPath,
    });
  }
}
