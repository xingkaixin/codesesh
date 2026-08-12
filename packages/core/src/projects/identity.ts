import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectIdentity, ProjectIdentityKind } from "../types/index.js";
import { fallbackDisplayName } from "./display-name.js";
import { realFs } from "./fs.js";

export interface IdentityFs {
  exists(path: string): boolean;
  readText(path: string): string | null;
  spawn(cmd: string, args: string[], opts: { cwd: string }): { stdout: string; exitCode: number };
}

export const PROJECT_IDENTITY_RESOLVER_REVISION = "project-identity-v2";

export interface ProjectIdentityProjection {
  identity: ProjectIdentity;
  resolverRevision: string;
  inputSignature: string;
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
type PathOps = Pick<
  typeof path.posix,
  "dirname" | "isAbsolute" | "join" | "relative" | "resolve" | "sep"
>;

// Identity semantics live in the contract; this module only discovers them
// from the filesystem and git.
export {
  getProjectIdentityKey,
  isProjectIdentityKind,
  matchesProjectIdentity,
} from "../contract/project-identity.js";

export function normalizeGitRemote(url: string): string | null {
  if (!url) return null;
  let value = url.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      value = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return null;
    }
  } else {
    const sshMatch = value.match(/^[^@]+@([^:]+):(.+)$/);
    if (sshMatch) value = `${sshMatch[1]}/${sshMatch[2]}`;
  }
  value = value.replace(/\.git$/, "");
  if (!value.includes("/")) return null;
  return value.toLowerCase();
}

// Process-lifetime identity cache, keyed by directory. Only used for the real
// filesystem (fs === realFs); tests inject fake IdentityFs implementations and
// must bypass the cache to stay isolated from each other. git remotes change
// rarely, so a coarse TTL is enough — no file-watch invalidation needed.
const IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;

interface IdentityCacheEntry {
  projection: ProjectIdentityProjection;
  resolvedAt: number;
}

const identityCache = new Map<string, IdentityCacheEntry>();

/** Clears the process-lifetime identity cache. For tests and explicit invalidation. */
export function clearIdentityCache(): void {
  identityCache.clear();
}

export function computeIdentity(cwd: string | null | undefined, fs: IdentityFs): ProjectIdentity {
  return computeIdentityProjection(cwd, fs).identity;
}

export function normalizeProjectDirectory(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return getPathOps(cwd).resolve(cwd);
}

export function computeIdentityProjection(
  cwd: string | null | undefined,
  fs: IdentityFs,
  resolverRevision = PROJECT_IDENTITY_RESOLVER_REVISION,
): ProjectIdentityProjection {
  if (fs !== realFs) return resolveIdentityProjection(cwd, fs, resolverRevision);

  const key = normalizeProjectDirectory(cwd);
  const cached = identityCache.get(key);
  if (
    cached &&
    cached.projection.resolverRevision === resolverRevision &&
    Date.now() - cached.resolvedAt < IDENTITY_CACHE_TTL_MS
  ) {
    return cached.projection;
  }
  const projection = resolveIdentityProjection(cwd, fs, resolverRevision);
  identityCache.set(key, { projection, resolvedAt: Date.now() });
  return projection;
}

function resolveIdentityProjection(
  cwd: string | null | undefined,
  fs: IdentityFs,
  resolverRevision: string,
): ProjectIdentityProjection {
  if (!cwd) return projectIdentityProjection(loose(), resolverRevision, ["loose", "missing"]);

  const pathOps = getPathOps(cwd);
  const absoluteCwd = pathOps.resolve(cwd);
  const homeDir = os.homedir();
  const homePathOps = getPathOps(homeDir);
  const home = homePathOps === pathOps ? pathOps.resolve(homeDir) : homeDir;
  if (absoluteCwd === home || LOOSE_DIRS.has(absoluteCwd)) {
    return projectIdentityProjection(loose(), resolverRevision, ["loose", absoluteCwd]);
  }
  if (
    homePathOps === pathOps &&
    LOOSE_HOME_DIRS.some((dir) => absoluteCwd === pathOps.join(home, dir))
  ) {
    return projectIdentityProjection(loose(), resolverRevision, ["loose", absoluteCwd]);
  }

  const gitRoot = findGitRoot(absoluteCwd, fs, pathOps);
  if (gitRoot) {
    const remote = fs.spawn("git", ["config", "--get", "remote.origin.url"], { cwd: gitRoot });
    if (remote.exitCode === 0) {
      const normalized = normalizeGitRemote(remote.stdout.trim());
      if (normalized) {
        const identity: ProjectIdentity = {
          kind: "git_remote",
          key: normalized,
          displayName: deriveDisplayName({ kind: "git_remote", key: normalized, gitRoot, fs }),
        };
        return projectIdentityProjection(identity, resolverRevision, [
          "git_remote",
          gitRoot,
          normalized,
          identity.displayName,
        ]);
      }
    }

    const common = fs.spawn("git", ["rev-parse", "--git-common-dir"], { cwd: gitRoot });
    if (common.exitCode === 0) {
      const raw = common.stdout.trim();
      if (raw) {
        const key = pathOps.isAbsolute(raw) ? raw : pathOps.resolve(gitRoot, raw);
        const identity: ProjectIdentity = {
          kind: "git_common_dir",
          key,
          displayName: deriveDisplayName({ kind: "git_common_dir", key, gitRoot, fs }),
        };
        return projectIdentityProjection(identity, resolverRevision, [
          "git_common_dir",
          gitRoot,
          key,
          identity.displayName,
        ]);
      }
    }
  }

  const manifestDir = findManifestDir(absoluteCwd, fs, pathOps);
  if (manifestDir) {
    const identity: ProjectIdentity = {
      kind: "manifest_path",
      key: manifestDir,
      displayName: deriveDisplayName({ kind: "manifest_path", key: manifestDir, fs }),
    };
    return projectIdentityProjection(identity, resolverRevision, [
      "manifest_path",
      manifestDir,
      identity.displayName,
    ]);
  }

  if (homePathOps === pathOps) {
    const synthetic = synthesizeCodexScratchIdentity(absoluteCwd, home, pathOps);
    if (synthetic) {
      return projectIdentityProjection(synthetic, resolverRevision, ["synthetic", synthetic.key]);
    }
  }

  const identity: ProjectIdentity = {
    kind: "path",
    key: absoluteCwd,
    displayName: fallbackDisplayName(absoluteCwd),
  };
  return projectIdentityProjection(identity, resolverRevision, ["path", absoluteCwd]);
}

function projectIdentityProjection(
  identity: ProjectIdentity,
  resolverRevision: string,
  inputs: readonly string[],
): ProjectIdentityProjection {
  return {
    identity,
    resolverRevision,
    inputSignature: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
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
  if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\")) {
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
