import { homedir, platform } from "node:os";
import { join } from "node:path";
import { firstExisting } from "../discovery/paths.js";
import { isSqliteAvailable } from "../utils/sqlite.js";
import { OpenCodeSqliteAgent } from "./opencode-sqlite.js";

export function resolveZCodeDataRoot(): string | null {
  const currentPlatform = platform();
  if (currentPlatform !== "darwin" && currentPlatform !== "win32") return null;
  return join(homedir(), ".zcode");
}

function findZCodeDbPath(): string | null {
  if (!isSqliteAvailable()) return null;
  const dataRoot = resolveZCodeDataRoot();
  if (!dataRoot) return null;
  return firstExisting(join(dataRoot, "cli", "db", "db.sqlite"));
}

function getZCodeSessionWatchPlan() {
  const dataRoot = resolveZCodeDataRoot();
  return {
    status: "supported" as const,
    targets: dataRoot ? [{ root: dataRoot, path: join(dataRoot, "cli", "db", "db.sqlite") }] : [],
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
