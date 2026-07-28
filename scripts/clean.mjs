/**
 * Cross-platform build-output cleanup.
 *
 * `rm -rf` is not available in cmd.exe, so the documented `pnpm clean` failed on
 * a plain Windows Node/pnpm setup. Targets come from a fixed manifest and are
 * verified to live inside the workspace that asked for them — a mistyped or
 * expanded path cannot reach outside it.
 *
 * Usage (from a workspace directory): node ../../scripts/clean.mjs
 */
import { rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build outputs a workspace may remove. Deliberately just the published output:
 * clearing Turbo's cache here would make the next build slower for no reason.
 */
export const CLEANABLE_DIRECTORIES = ["dist"];

/** Resolves the targets a workspace is allowed to delete, rejecting any escape. */
export function resolveCleanTargets(workspaceDir, names = CLEANABLE_DIRECTORIES) {
  const workspace = resolve(workspaceDir);
  const targets = [];

  for (const name of names) {
    const target = resolve(workspace, name);
    const location = relative(workspace, target);
    if (location === "" || location.startsWith("..") || resolve(workspace, location) !== target) {
      throw new Error(`Refusing to clean ${name}: outside ${workspace}`);
    }
    targets.push(target);
  }

  return targets;
}

function main() {
  const workspaceDir = process.cwd();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (relative(repoRoot, resolve(workspaceDir)).startsWith("..")) {
    console.error(`Refusing to clean ${workspaceDir}: outside ${repoRoot}`);
    process.exit(1);
  }

  for (const target of resolveCleanTargets(workspaceDir)) {
    // Repeat runs are fine: a missing directory is already clean.
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
