/**
 * Read-only check that every published version agrees before a release mutates
 * anything. A release rewrites the CLI manifest and publishes to npm; a manifest
 * missed during preparation would otherwise ship a package whose version
 * disagrees with the tag, the web `__APP_VERSION__` and the site.
 *
 * Usage:
 *   node scripts/release-preflight.mjs            # manifests agree with each other
 *   node scripts/release-preflight.mjs v1.2.3     # ...and with the tag
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSIONED_MANIFESTS = [
  "packages/contract/package.json",
  "apps/web/package.json",
  "apps/www/package.json",
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/** Strips exactly one leading `v`; anything else is not a release tag. */
export function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) return null;
  const version = tag.slice(1);
  return SEMVER.test(version) ? version : null;
}

export function checkReleaseVersions({ tag, manifests }) {
  const problems = [];
  const expected = tag == null ? manifests[0]?.version : versionFromTag(tag);

  if (tag != null && expected == null) {
    return { ok: false, expected: null, problems: [`Tag ${tag} is not a v-prefixed semver tag`] };
  }

  for (const manifest of manifests) {
    if (!SEMVER.test(manifest.version ?? "")) {
      problems.push(
        `${manifest.path} has a non-semver version: ${manifest.version ?? "(missing)"}`,
      );
      continue;
    }
    if (manifest.version !== expected) {
      problems.push(`${manifest.path} is ${manifest.version}, expected ${expected}`);
    }
  }

  return { ok: problems.length === 0, expected, problems };
}

export function readManifests(repoRoot) {
  const cargo = readFileSync(join(repoRoot, "Cargo.toml"), "utf8");
  const workspace = cargo.split(/^\[workspace\.package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const versions = [...(workspace ?? "").matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (versions.length !== 1)
    throw new Error("Cargo.toml must declare one workspace.package version");
  return [
    { path: "Cargo.toml", version: versions[0][1] },
    ...VERSIONED_MANIFESTS.map((path) => ({
      path,
      version: JSON.parse(readFileSync(join(repoRoot, path), "utf8")).version,
    })),
  ];
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tag = process.argv[2];
  const result = checkReleaseVersions({ tag: tag ?? null, manifests: readManifests(repoRoot) });

  if (!result.ok) {
    console.error("Release preflight failed:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`Release preflight passed: every manifest is ${result.expected}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
