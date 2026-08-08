import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const cliDir = join(rootDir, "packages", "cli");
const artifactDir = join(rootDir, "artifacts", "npm");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const requiredFiles = [
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/scan-refresh-worker.js",
  "dist/search-index-worker.js",
  "dist/smart-tag-worker.js",
  "dist/web/index.html",
];

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  execFileSync(executable, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

function isWorkspaceReference(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

export function createPublishManifest(source) {
  const manifest = structuredClone(source);
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (!isWorkspaceReference(value)) continue;
      if (field === "devDependencies" || name === "@codesesh/core") {
        delete dependencies[name];
        continue;
      }
      throw new Error(`Cannot publish workspace dependency ${name} from ${field}`);
    }
  }
  return manifest;
}

export function assertNoWorkspaceReferences(manifest) {
  for (const field of dependencyFields) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (isWorkspaceReference(value)) {
        throw new Error(`Packed manifest contains workspace dependency ${field}.${name}`);
      }
    }
  }
}

export function validatePackedFiles(files) {
  const paths = new Set(files);
  for (const path of requiredFiles) {
    if (!paths.has(path)) throw new Error(`Packed artifact is missing ${path}`);
  }
  for (const path of paths) {
    if (path !== "README.md" && path !== "package.json" && !path.startsWith("dist/")) {
      throw new Error(`Packed artifact contains unexpected file ${path}`);
    }
  }
  const hashedAssets = [...paths].filter((path) =>
    /^dist\/web\/assets\/.+-[A-Za-z0-9_-]+\.(?:css|js)$/.test(path),
  );
  if (!hashedAssets.some((path) => path.endsWith(".js"))) {
    throw new Error("Packed artifact has no hashed Web JavaScript asset");
  }
  if (!hashedAssets.some((path) => path.endsWith(".css"))) {
    throw new Error("Packed artifact has no hashed Web stylesheet asset");
  }
}

function validateBundledEntries() {
  const paths = readdirSync(join(cliDir, "dist"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => `dist/${entry.name}`);
  for (const path of paths) {
    const content = readFileSync(join(cliDir, path), "utf8");
    if (/\b(?:from|import\s*\()\s*["']@codesesh\/core(?:\/[^"']*)?["']/.test(content)) {
      throw new Error(`${path} still imports @codesesh/core`);
    }
  }
}

function buildPackage() {
  const pnpm = command("pnpm");
  run(pnpm, ["--filter", "@codesesh/core", "build"]);
  run(pnpm, ["--filter", "@codesesh/web", "build"]);
  run(pnpm, ["--filter", "codesesh", "run", "release"], {
    env: {
      ...process.env,
      BUNDLE_CORE: "true",
      CODESESH_ARTIFACT_MODE: "true",
    },
  });
  validateBundledEntries();
}

function packPackage() {
  const stageRoot = mkdtempSync(join(tmpdir(), "codesesh-artifact-stage-"));
  const stageDir = join(stageRoot, "package");
  try {
    mkdirSync(stageDir, { recursive: true });
    cpSync(join(cliDir, "dist"), join(stageDir, "dist"), { recursive: true });
    cpSync(join(cliDir, "README.md"), join(stageDir, "README.md"));
    const sourceManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
    const publishManifest = createPublishManifest(sourceManifest);
    assertNoWorkspaceReferences(publishManifest);
    writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`);

    if (relative(rootDir, artifactDir) !== "artifacts/npm") {
      throw new Error(`Refusing to clear unexpected artifact directory ${artifactDir}`);
    }
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    const output = execFileSync(
      command("npm"),
      ["pack", stageDir, "--pack-destination", artifactDir, "--json", "--ignore-scripts"],
      { cwd: rootDir, encoding: "utf8" },
    );
    const [result] = JSON.parse(output);
    if (!result?.filename || !Array.isArray(result.files)) {
      throw new Error("npm pack did not report an artifact file list");
    }
    validatePackedFiles(result.files.map((file) => file.path));
    const tarballPath = join(artifactDir, basename(result.filename));
    if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
    const checksum = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    writeFileSync(`${tarballPath}.sha256`, `${checksum}  ${basename(tarballPath)}\n`);
    return { checksum, tarballPath };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function buildPackageArtifact() {
  buildPackage();
  return packPackage();
}

function main() {
  const result = buildPackageArtifact();
  console.log(`Artifact: ${relative(rootDir, result.tarballPath)}`);
  console.log(`SHA-256: ${result.checksum}`);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
