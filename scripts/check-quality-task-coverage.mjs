import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";

export const QUALITY_TASKS = ["lint", "lint:fix", "format", "format:check"];
export const QUALITY_PACKAGES = [
  { name: "codesesh-monorepo", manifest: "package.json", turbo: false },
  { name: "@codesesh/core", manifest: "packages/core/package.json" },
  { name: "codesesh", manifest: "packages/cli/package.json" },
  { name: "@codesesh/web", manifest: "apps/web/package.json" },
  { name: "@codesesh/www", manifest: "apps/www/package.json" },
];
export const WWW_TASK_REQUIREMENTS = {
  lint: ["oxlint", "eslint", "src/**/*.astro"],
  "lint:fix": ["oxlint", "eslint", "src/**/*.astro"],
  format: ["oxfmt", "prettier", "src/**/*.astro"],
  "format:check": ["oxfmt", "prettier", "src/**/*.astro"],
};
export const SCRIPT_PACKAGE_TASK_REQUIREMENTS = {
  lint: ["oxlint ."],
  "lint:fix": ["oxlint .", "--fix"],
  format: ["oxfmt --write", "**/*.{js,mjs,cjs,ts,tsx}"],
  "format:check": ["oxfmt --check", "**/*.{js,mjs,cjs,ts,tsx}"],
};
export const ROOT_TASK_REQUIREMENTS = {
  lint: ["pnpm lint:root", "turbo run lint"],
  "lint:root": ["oxlint", "scripts", "tests", "playwright.config.ts", "vitest.config.ts"],
  "lint:fix": ["pnpm lint:fix:root", "turbo run lint:fix"],
  "lint:fix:root": [
    "oxlint",
    "scripts",
    "tests",
    "playwright.config.ts",
    "vitest.config.ts",
    "--fix",
  ],
  format: ["pnpm format:root", "turbo run format"],
  "format:root": [
    "oxfmt",
    "--write",
    "scripts/**/*.{js,mjs,cjs,ts,tsx}",
    "tests/**/*.{js,mjs,cjs,ts,tsx}",
    "playwright.config.ts",
    "vitest.config.ts",
  ],
  "format:check": ["pnpm format:check:root", "turbo run format:check"],
  "format:check:root": [
    "oxfmt",
    "--check",
    "scripts/**/*.{js,mjs,cjs,ts,tsx}",
    "tests/**/*.{js,mjs,cjs,ts,tsx}",
    "playwright.config.ts",
    "vitest.config.ts",
  ],
};

export function findManifestTaskGaps(manifests, tasks = QUALITY_TASKS) {
  return manifests.flatMap(({ name, scripts = {} }) =>
    tasks
      .filter((task) => typeof scripts[task] !== "string" || scripts[task].trim() === "")
      .map((task) => `${name}#${task} has no package script`),
  );
}

export function findTurboTaskGaps(dryRun, packageNames, task) {
  const tasks = new Map(dryRun.tasks.map((entry) => [entry.taskId, entry.command]));
  return packageNames.flatMap((packageName) => {
    const taskId = `${packageName}#${task}`;
    const command = tasks.get(taskId);
    return !command || command === "<NONEXISTENT>" ? [`${taskId} is ${command ?? "missing"}`] : [];
  });
}

export function findCommandCoverageGaps(
  scripts,
  requirements = WWW_TASK_REQUIREMENTS,
  packageName = "@codesesh/www",
) {
  return Object.entries(requirements).flatMap(([task, requiredTokens]) => {
    const command = scripts[task] ?? "";
    const missing = requiredTokens.filter((token) => !command.includes(token));
    return missing.length > 0 ? [`${packageName}#${task} misses ${missing.join(", ")}`] : [];
  });
}

export function findAstroCoverageGaps(expectedFiles, eslintFiles, prettierFileInfo) {
  const eslintSet = new Set(eslintFiles);
  const missing = expectedFiles.filter((path) => !eslintSet.has(path));
  return [
    missing.length > 0 ? `ESLint missed Astro files: ${missing.join(", ")}` : null,
    prettierFileInfo.ignored ? "Prettier ignores ProductDemo.astro" : null,
    prettierFileInfo.inferredParser !== "astro"
      ? `Prettier selected ${prettierFileInfo.inferredParser ?? "no parser"} for ProductDemo.astro`
      : null,
  ].filter(Boolean);
}

function listFiles(root, extension) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path, extension));
    else if (entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

function runPnpm(repoRoot, args) {
  const { executable, shell } = getPnpmInvocation();
  return execFileSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function readQualityManifests(repoRoot) {
  return QUALITY_PACKAGES.map(({ name, manifest }) => {
    const parsed = JSON.parse(readFileSync(join(repoRoot, manifest), "utf8"));
    if (parsed.name !== name)
      throw new Error(`${manifest} declares ${parsed.name}, expected ${name}`);
    return parsed;
  });
}

function inspectTurboTasks(repoRoot) {
  const packageNames = QUALITY_PACKAGES.filter(({ turbo = true }) => turbo).map(({ name }) => name);
  const dryRun = JSON.parse(
    runPnpm(repoRoot, ["exec", "turbo", "run", ...QUALITY_TASKS, "--dry=json"]),
  );
  return QUALITY_TASKS.flatMap((task) => findTurboTaskGaps(dryRun, packageNames, task));
}

function inspectAstroCoverage(repoRoot) {
  const wwwRoot = join(repoRoot, "apps/www");
  const expectedFiles = listFiles(join(wwwRoot, "src"), ".astro").map((path) =>
    relative(wwwRoot, path),
  );
  const eslintResults = JSON.parse(
    runPnpm(repoRoot, [
      "--dir",
      "apps/www",
      "exec",
      "eslint",
      "src/**/*.astro",
      "--format",
      "json",
    ]),
  );
  const eslintFiles = eslintResults.map(({ filePath }) => relative(wwwRoot, filePath));
  const prettierFileInfo = JSON.parse(
    runPnpm(repoRoot, [
      "--dir",
      "apps/www",
      "exec",
      "prettier",
      "--file-info",
      "src/components/ProductDemo.astro",
    ]),
  );
  return {
    count: expectedFiles.length,
    gaps: findAstroCoverageGaps(expectedFiles, eslintFiles, prettierFileInfo),
  };
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifests = readQualityManifests(repoRoot);
  const rootManifest = manifests.find(({ name }) => name === "codesesh-monorepo");
  const wwwManifest = manifests.find(({ name }) => name === "@codesesh/www");
  const scriptPackageManifests = manifests.filter(({ name }) =>
    ["@codesesh/core", "codesesh", "@codesesh/web"].includes(name),
  );
  const gaps = [
    ...findManifestTaskGaps(manifests),
    ...findCommandCoverageGaps(
      rootManifest?.scripts ?? {},
      ROOT_TASK_REQUIREMENTS,
      "codesesh-monorepo",
    ),
    ...findCommandCoverageGaps(wwwManifest?.scripts ?? {}),
    ...scriptPackageManifests.flatMap(({ name, scripts }) =>
      findCommandCoverageGaps(scripts, SCRIPT_PACKAGE_TASK_REQUIREMENTS, name),
    ),
    ...inspectTurboTasks(repoRoot),
  ];
  const astro = inspectAstroCoverage(repoRoot);
  gaps.push(...astro.gaps);

  if (gaps.length > 0) {
    console.error("Quality task coverage is incomplete:");
    for (const gap of gaps) console.error(`  - ${gap}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Quality tasks cover the repository root and ${QUALITY_PACKAGES.length - 1} packages; ESLint and Prettier parse ${astro.count} Astro files`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
