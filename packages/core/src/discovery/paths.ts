import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Expand the tilde prefixes shells accept for home-relative paths. */
function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Blank values count as unset, `~` expands, and relative paths resolve — so
 * CODEX_HOME=~/data points at the home directory instead of a literal
 * ./~/data that silently yields zero sessions.
 */
export function readEnvPath(name: string): string | null {
  const value = process.env[name];
  if (!value || !value.trim()) return null;
  const expanded = expandHomePath(value.trim());
  // resolve() would also prepend a drive letter to POSIX-absolute paths on
  // Windows; only relative inputs actually need anchoring.
  return isAbsolute(expanded) ? expanded : resolve(expanded);
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
