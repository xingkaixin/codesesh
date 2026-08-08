import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FACT_SPECS = [
  { document: "README.md", fact: "agents" },
  { document: "README_CN.md", fact: "agents" },
  { document: "apps/www/public/llms-full.txt", fact: "agents" },
  { document: "docs/scanning-and-caching.md", fact: "agent-source-kinds" },
  { document: "docs/architecture.md", fact: "agent-source-kinds" },
  { document: "docs/sqlite-storage.md", fact: "cache-schema-version" },
  { document: "README.md", fact: "pnpm-version" },
  { document: "README_CN.md", fact: "pnpm-version" },
  { document: "apps/www/public/llms-full.txt", fact: "pnpm-version" },
];

export const CHECKED_FACT_DOCUMENTS = [...new Set(FACT_SPECS.map(({ document }) => document))];

export function extractMarkedFactRegions(contents, fact) {
  const pattern = new RegExp(
    `<!--\\s*repo-fact:${fact}:start\\s*-->([\\s\\S]*?)<!--\\s*repo-fact:${fact}:end\\s*-->`,
    "g",
  );
  return [...contents.matchAll(pattern)].map((match) => match[1]);
}

export function readPnpmVersion(repoRoot) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  if (!match) throw new Error("package.json packageManager must be an exact pnpm version");
  return match[1];
}

function unique(values) {
  return [...new Set(values)];
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function compareNames(expected, actual) {
  const expectedNames = sorted(unique(expected));
  const actualNames = sorted(unique(actual));
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  const duplicates = unique(actual.filter((name, index) => actual.indexOf(name) !== index));
  if (missing.length === 0 && unexpected.length === 0 && duplicates.length === 0) return null;

  return [
    missing.length > 0 ? `missing ${JSON.stringify(missing)}` : null,
    unexpected.length > 0 ? `unexpected ${JSON.stringify(unexpected)}` : null,
    duplicates.length > 0 ? `duplicated ${JSON.stringify(sorted(duplicates))}` : null,
    `expected ${JSON.stringify(expectedNames)}`,
    `documented ${JSON.stringify(actualNames)}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function parseAgentNames(region) {
  const tableNames = [...region.matchAll(/^\|\s*([^|\n]+?)\s*\|.*$/gm)]
    .map((match) => match[1].trim())
    .filter((name) => name !== "Agent" && !/^-+$/.test(name));
  if (tableNames.length > 0) return tableNames;
  return [...region.matchAll(/^\s*-\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
}

function parseSourceKindNames(region) {
  const filesystem = /文件(?:系统|型)\s*[:：]\s*([^\n│]+)/u.exec(region)?.[1];
  const sqlite = /SQLite(?:\s+数据库型)?\s*[:：]\s*([^\n│]+)/u.exec(region)?.[1];
  if (!filesystem || !sqlite) return null;

  const splitNames = (value) => value.split(/\s*(?:、|·)\s*/u).filter(Boolean);
  return { filesystem: splitNames(filesystem.trim()), sqlite: splitNames(sqlite.trim()) };
}

function validateRegion(fact, region, repositoryFacts) {
  if (fact === "pnpm-version") {
    const versions = [...region.matchAll(/\bpnpm\s+(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]);
    if (versions.length === 0) return "marker contains no `pnpm x.y.z` declaration";
    const stale = unique(versions.filter((version) => version !== repositoryFacts.pnpmVersion));
    return stale.length > 0
      ? `expected pnpm ${repositoryFacts.pnpmVersion}; documented ${stale.join(", ")}`
      : null;
  }

  if (fact === "cache-schema-version") {
    const versions = [...region.matchAll(/CACHE_SCHEMA_VERSION\s*=\s*(\d+)/g)].map((match) =>
      Number(match[1]),
    );
    if (versions.length === 0) return "marker contains no `CACHE_SCHEMA_VERSION = n` declaration";
    const stale = unique(
      versions.filter((version) => version !== repositoryFacts.cacheSchemaVersion),
    );
    return stale.length > 0
      ? `expected CACHE_SCHEMA_VERSION = ${repositoryFacts.cacheSchemaVersion}; documented ${stale.join(", ")}`
      : null;
  }

  if (fact === "agents") {
    return compareNames(
      repositoryFacts.agents.map(({ displayName }) => displayName),
      parseAgentNames(region),
    );
  }

  const documented = parseSourceKindNames(region);
  if (!documented) return "marker must declare both filesystem and SQLite agent lists";
  const filesystemMismatch = compareNames(
    repositoryFacts.agents
      .filter(({ sourceKind }) => sourceKind === "filesystem")
      .map(({ displayName }) => displayName),
    documented.filesystem,
  );
  const sqliteMismatch = compareNames(
    repositoryFacts.agents
      .filter(({ sourceKind }) => sourceKind === "sqlite")
      .map(({ displayName }) => displayName),
    documented.sqlite,
  );
  return [
    filesystemMismatch ? `filesystem: ${filesystemMismatch}` : null,
    sqliteMismatch ? `sqlite: ${sqliteMismatch}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export function findDocumentationFactMismatches(repoRoot, coreFacts) {
  const repositoryFacts = { ...coreFacts, pnpmVersion: readPnpmVersion(repoRoot) };
  const mismatches = [];

  for (const { document, fact } of FACT_SPECS) {
    const fullPath = join(repoRoot, document);
    if (!existsSync(fullPath)) {
      mismatches.push({ document, fact, message: "document not found" });
      continue;
    }

    const regions = extractMarkedFactRegions(readFileSync(fullPath, "utf8"), fact);
    if (regions.length === 0) {
      mismatches.push({ document, fact, message: `missing repo-fact:${fact} marker` });
      continue;
    }

    regions.forEach((region, index) => {
      const message = validateRegion(fact, region, repositoryFacts);
      if (message) {
        mismatches.push({
          document,
          fact,
          message: regions.length > 1 ? `region ${index + 1}: ${message}` : message,
        });
      }
    });
  }

  return mismatches;
}

async function loadCoreRepositoryFacts(repoRoot) {
  const modulePath = join(repoRoot, "packages/core/dist/repository-facts.mjs");
  if (!existsSync(modulePath)) {
    throw new Error(
      "Core repository facts are not built; run `pnpm --filter @codesesh/core build`",
    );
  }
  const module = await import(pathToFileURL(modulePath).href);
  return module.getCoreRepositoryFacts();
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mismatches = findDocumentationFactMismatches(
    repoRoot,
    await loadCoreRepositoryFacts(repoRoot),
  );

  if (mismatches.length > 0) {
    console.error("Documentation repository facts are out of date:");
    for (const { document, fact, message } of mismatches) {
      console.error(`  - ${document} [${fact}]: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Documentation facts agree in ${CHECKED_FACT_DOCUMENTS.length} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
