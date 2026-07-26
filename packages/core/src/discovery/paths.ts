import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function readEnvPath(name: string): string | null {
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

export function resolveDataHome(): string {
  const xdg = readEnvPath("XDG_DATA_HOME");
  if (xdg) return xdg;

  const p = platform();
  if (p === "win32") {
    return (
      readEnvPath("LOCALAPPDATA") ?? readEnvPath("APPDATA") ?? join(homedir(), "AppData", "Local")
    );
  }

  // macOS / Linux
  return join(homedir(), ".local", "share");
}

export function resolveHomePath(environmentVariable: string, fallbackDirectory: string): string {
  return readEnvPath(environmentVariable) ?? join(homedir(), fallbackDirectory);
}

export { firstExisting };
