/**
 * Verifies that repository paths quoted in documentation still exist.
 *
 * Docs drifted silently once code moved: `discovery/cache.ts` was deleted while
 * two documents still called it the stable entry point. This only checks
 * backticked paths that look like repository files or directories — prose,
 * commands and external references are left alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKED_DOCUMENTS = [
  "README.md",
  "README_CN.md",
  "packages/cli/README.md",
  "docs/PRD.md",
  "docs/architecture.md",
  "docs/scanning-and-caching.md",
  "docs/sqlite-storage.md",
  "docs/release-guide.md",
];

/** Directories a repository path must start with to be checked. */
const REPO_ROOTS = ["packages/", "apps/", "docs/", "scripts/", ".github/"];

/** Paths that stand for a pattern or a placeholder rather than a file. */
function isTemplate(path) {
  return path.includes("*") || path.includes("<");
}

/**
 * Build output. Whether it exists depends on whether anything has been built,
 * not on whether the documentation is accurate.
 */
function isBuildOutput(path) {
  return path.includes("/dist/") || path.endsWith("/dist");
}

export function extractRepositoryPaths(markdown) {
  const quoted = markdown.match(/`[^`\n]+`/g) ?? [];
  return [
    ...new Set(
      quoted
        .map((token) => token.slice(1, -1).trim())
        .filter((token) => REPO_ROOTS.some((root) => token.startsWith(root)))
        .filter((token) => !isTemplate(token) && !isBuildOutput(token)),
    ),
  ];
}

export function findMissingPaths(repoRoot, documents) {
  const missing = [];
  for (const document of documents) {
    const fullPath = join(repoRoot, document);
    if (!existsSync(fullPath)) {
      missing.push({ document, path: document, reason: "document not found" });
      continue;
    }
    for (const path of extractRepositoryPaths(readFileSync(fullPath, "utf8"))) {
      if (!existsSync(join(repoRoot, path))) missing.push({ document, path });
    }
  }
  return missing;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const missing = findMissingPaths(repoRoot, CHECKED_DOCUMENTS);

  if (missing.length > 0) {
    console.error("Documentation references paths that do not exist:");
    for (const entry of missing) {
      console.error(`  - ${entry.document}: ${entry.path}${entry.reason ? ` (${entry.reason})` : ""}`);
    }
    process.exit(1);
  }

  console.log(`Documentation paths resolve in ${CHECKED_DOCUMENTS.length} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
