import { homedir } from "node:os";
import * as path from "node:path";
import type { ProjectIdentity, ProjectIdentityKind } from "../types/index.js";
import { fallbackDisplayName } from "./display-name.js";

export interface IdentityFs {
  exists(path: string): boolean;
  readText(path: string): string | null;
  spawn(cmd: string, args: string[], opts: { cwd: string }): { stdout: string; exitCode: number };
}

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
] as const;

const PARSEABLE_MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml"] as const;

const LOOSE_DIRS = new Set(["/tmp", "/private/tmp"]);
const LOOSE_HOME_DIRS = ["Desktop", "Downloads", "Documents"];
type PathOps = Pick<typeof path.posix, "dirname" | "isAbsolute" | "join" | "resolve">;

export function normalizeGitRemote(url: string): string | null {
  if (!url) return null;
  let value = url.trim().replace(/\.git$/, "");
  const sshMatch = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) value = `${sshMatch[1]}/${sshMatch[2]}`;
  value = value.replace(/^[a-z]+:\/\/(?:[^@/]*@)?/i, "");
  if (!value.includes("/")) return null;
  return value.toLowerCase();
}

export function computeIdentity(cwd: string | null | undefined, fs: IdentityFs): ProjectIdentity {
  if (!cwd) return loose();

  const pathOps = getPathOps(cwd);
  const absoluteCwd = pathOps.resolve(cwd);
  const homeDir = homedir();
  const homePathOps = getPathOps(homeDir);
  const home = homePathOps === pathOps ? pathOps.resolve(homeDir) : homeDir;
  if (absoluteCwd === home || LOOSE_DIRS.has(absoluteCwd)) return loose();
  if (
    homePathOps === pathOps &&
    LOOSE_HOME_DIRS.some((dir) => absoluteCwd === pathOps.join(home, dir))
  ) {
    return loose();
  }

  const gitRoot = findGitRoot(absoluteCwd, fs, pathOps);
  if (gitRoot) {
    const remote = fs.spawn("git", ["config", "--get", "remote.origin.url"], { cwd: gitRoot });
    if (remote.exitCode === 0) {
      const normalized = normalizeGitRemote(remote.stdout.trim());
      if (normalized) {
        return {
          kind: "git_remote",
          key: normalized,
          displayName: deriveDisplayName({ kind: "git_remote", key: normalized, gitRoot, fs }),
        };
      }
    }

    const common = fs.spawn("git", ["rev-parse", "--git-common-dir"], { cwd: gitRoot });
    if (common.exitCode === 0) {
      const raw = common.stdout.trim();
      if (raw) {
        const key = pathOps.isAbsolute(raw) ? raw : pathOps.resolve(gitRoot, raw);
        return {
          kind: "git_common_dir",
          key,
          displayName: deriveDisplayName({ kind: "git_common_dir", key, gitRoot, fs }),
        };
      }
    }
  }

  const manifestDir = findManifestDir(absoluteCwd, fs, pathOps);
  if (manifestDir) {
    return {
      kind: "manifest_path",
      key: manifestDir,
      displayName: deriveDisplayName({ kind: "manifest_path", key: manifestDir, fs }),
    };
  }

  return {
    kind: "path",
    key: absoluteCwd,
    displayName: fallbackDisplayName(absoluteCwd),
  };
}

function loose(): ProjectIdentity {
  return { kind: "loose", key: "loose", displayName: "Loose" };
}

function getPathOps(input: string): PathOps {
  if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.includes("\\")) {
    return path.win32;
  }
  if (input.startsWith("/")) return path.posix;
  return path;
}

function findGitRoot(start: string, fs: IdentityFs, pathOps: PathOps): string | null {
  let current = start;
  while (current) {
    if (fs.exists(pathOps.join(current, ".git"))) return current;
    const parent = pathOps.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findManifestDir(start: string, fs: IdentityFs, pathOps: PathOps): string | null {
  let current = start;
  while (current) {
    for (const manifest of MANIFESTS) {
      if (fs.exists(pathOps.join(current, manifest))) return current;
    }
    const parent = pathOps.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

interface DisplayNameInput {
  kind: ProjectIdentityKind;
  key: string;
  gitRoot?: string;
  fs: IdentityFs;
}

function deriveDisplayName(input: DisplayNameInput): string {
  const pathOps = getPathOps(input.gitRoot ?? input.key);
  const dir = input.gitRoot ?? (input.kind === "manifest_path" ? input.key : null);
  if (dir) {
    for (const manifest of PARSEABLE_MANIFESTS) {
      const manifestPath = pathOps.join(dir, manifest);
      if (input.fs.exists(manifestPath)) {
        const name = parseManifestName(manifest, input.fs.readText(manifestPath) ?? "");
        if (name) return name;
      }
    }
  }

  if (input.kind === "git_remote") {
    return input.key.split("/").at(-1) || input.key;
  }
  if (input.gitRoot) return fallbackDisplayName(input.gitRoot);
  return fallbackDisplayName(input.key);
}

function parseManifestName(file: string, text: string): string | null {
  if (!text) return null;
  if (file === "package.json" || file === "Cargo.toml" || file === "pyproject.toml") {
    const match = text.match(/"name"\s*:\s*"([^"]+)"/) || text.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  }
  return null;
}
