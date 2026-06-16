import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

function envPath(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  return value;
}

function firstExisting(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function getDataHome(): string {
  const xdg = envPath("XDG_DATA_HOME");
  if (xdg) return xdg;

  const p = platform();
  if (p === "win32") {
    return envPath("LOCALAPPDATA") ?? envPath("APPDATA") ?? join(homedir(), "AppData", "Local");
  }

  // macOS / Linux
  return join(homedir(), ".local", "share");
}

export interface ProviderRoots {
  codexRoot: string;
  claudeRoot: string;
  kimiRoot: string;
  opencodeRoot: string;
  piRoot: string;
}

export function resolveProviderRoots(): ProviderRoots {
  const home = homedir();
  return {
    codexRoot: envPath("CODEX_HOME") ?? join(home, ".codex"),
    claudeRoot: envPath("CLAUDE_CONFIG_DIR") ?? join(home, ".claude"),
    kimiRoot: envPath("KIMI_SHARE_DIR") ?? join(home, ".kimi"),
    opencodeRoot: join(getDataHome(), "opencode"),
    piRoot: envPath("PI_HOME") ?? join(home, ".pi"),
  };
}

export function getCursorDataPath(): string | null {
  const override = envPath("CURSOR_DATA_PATH");
  if (override) return override;

  const p = platform();
  if (p === "darwin") {
    return firstExisting(join(homedir(), "Library", "Application Support", "Cursor", "User"));
  }
  if (p === "linux") {
    const xdg = envPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
    return firstExisting(join(xdg, "Cursor", "User"));
  }
  if (p === "win32") {
    const appData = envPath("APPDATA") ?? join(homedir(), "AppData", "Roaming");
    return firstExisting(join(appData, "Cursor", "User"));
  }
  return null;
}

export { firstExisting };
