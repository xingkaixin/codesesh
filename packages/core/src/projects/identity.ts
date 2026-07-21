import * as os from "node:os";
import * as path from "node:path";
import type { ProjectIdentity, ProjectIdentityKind, ProjectIdentityRef } from "../types/index.js";
import { fallbackDisplayName } from "./display-name.js";
import { realFs } from "./fs.js";

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
const PROJECT_IDENTITY_KINDS = new Set<ProjectIdentityKind>([
  "git_remote",
  "git_common_dir",
  "manifest_path",
  "synthetic",
  "path",
  "loose",
]);
type PathOps = Pick<
  typeof path.posix,
  "dirname" | "isAbsolute" | "join" | "relative" | "resolve" | "sep"
>;

export function isProjectIdentityKind(value: string): value is ProjectIdentityKind {
  return PROJECT_IDENTITY_KINDS.has(value as ProjectIdentityKind);
}

export function getProjectIdentityKey(identity: ProjectIdentityRef): string {
  return `${identity.kind}:${identity.key}`;
}

export function matchesProjectIdentity(
  identity: ProjectIdentityRef | null | undefined,
  expected: ProjectIdentityRef,
): boolean {
  return identity?.kind === expected.kind && identity.key === expected.key;
}

export function normalizeGitRemote(url: string): string | null {
  if (!url) return null;
  let value = url.trim().replace(/\.git$/, "");
  const sshMatch = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) value = `${sshMatch[1]}/${sshMatch[2]}`;
  value = value.replace(/^[a-z]+:\/\/(?:[^@/]*@)?/i, "");
  if (!value.includes("/")) return null;
  return value.toLowerCase();
}

// Process-lifetime identity cache, keyed by directory. Only used for the real
// filesystem (fs === realFs); tests inject fake IdentityFs implementations and
// must bypass the cache to stay isolated from each other. git remotes change
// rarely, so a coarse TTL is enough — no file-watch invalidation needed.
const IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;

interface IdentityCacheEntry {
  identity: ProjectIdentity;
  resolvedAt: number;
}

const identityCache = new Map<string, IdentityCacheEntry>();

/** Clears the process-lifetime identity cache. For tests and explicit invalidation. */
export function clearIdentityCache(): void {
  identityCache.clear();
}

export function computeIdentity(cwd: string | null | undefined, fs: IdentityFs): ProjectIdentity {
  if (fs !== realFs) return resolveIdentity(cwd, fs);

  const key = cwd ?? "";
  const cached = identityCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < IDENTITY_CACHE_TTL_MS) {
    return cached.identity;
  }
  const identity = resolveIdentity(cwd, fs);
  identityCache.set(key, { identity, resolvedAt: Date.now() });
  return identity;
}

function resolveIdentity(cwd: string | null | undefined, fs: IdentityFs): ProjectIdentity {
  if (!cwd) return loose();

  const pathOps = getPathOps(cwd);
  const absoluteCwd = pathOps.resolve(cwd);
  const homeDir = os.homedir();
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

  if (homePathOps === pathOps) {
    const synthetic = synthesizeCodexScratchIdentity(absoluteCwd, home, pathOps);
    if (synthetic) return synthetic;
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

function synthesizeCodexScratchIdentity(
  absoluteCwd: string,
  home: string,
  pathOps: PathOps,
): ProjectIdentity | null {
  const root = pathOps.resolve(pathOps.join(home, "Documents", "Codex"));
  const child = pathOps.relative(root, absoluteCwd);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${pathOps.sep}`) ||
    pathOps.isAbsolute(child)
  ) {
    return null;
  }
  return { kind: "synthetic", key: "codex:scratch", displayName: "Chats" };
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
