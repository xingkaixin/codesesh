import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_ROOTS = ["packages/core/src", "packages/cli/src", "apps/web/src", "apps/www/src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function isProductionSource(path) {
  return (
    SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
    !path.endsWith(".d.ts") &&
    !path.includes("/__tests__/") &&
    !/\.(?:test|spec)\.[cm]?tsx?$/.test(path)
  );
}

function listSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (isProductionSource(path)) files.push(resolve(path));
  }
  return files;
}

function resolveLocalModule(sourcePath, specifier, sourceFiles) {
  const withoutJsExtension = specifier.replace(/\.[cm]?js$/, "");
  const base = resolve(dirname(sourcePath), withoutJsExtension);
  const candidates = [
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function localDependencies(sourcePath, sourceFiles) {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const dependencies = [];
  ts.forEachChild(source, (node) => {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return;
    const specifier = node.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return;
    const dependency = resolveLocalModule(sourcePath, specifier.text, sourceFiles);
    if (dependency) dependencies.push(dependency);
  });
  return dependencies;
}

function findCycles(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function visit(source) {
    indexes.set(source, nextIndex);
    lowLinks.set(source, nextIndex);
    nextIndex += 1;
    stack.push(source);
    onStack.add(source);

    for (const dependency of graph.get(source) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(source, Math.min(lowLinks.get(source), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(source, Math.min(lowLinks.get(source), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(source) !== indexes.get(source)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== source);

    const selfCycle =
      component.length === 1 && (graph.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component);
  }

  for (const source of graph.keys()) {
    if (!indexes.has(source)) visit(source);
  }
  return cycles;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = SOURCE_ROOTS.flatMap((root) => listSourceFiles(join(repoRoot, root)));
  const sourceFiles = new Set(files);
  const graph = new Map(files.map((source) => [source, localDependencies(source, sourceFiles)]));
  const cycles = findCycles(graph);

  if (cycles.length > 0) {
    console.error("Production import cycles found:");
    for (const cycle of cycles) {
      console.error(`  - ${cycle.map((path) => relative(repoRoot, path)).join(" -> ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Production import graph is acyclic across ${files.length} TypeScript files`);
}

main();
