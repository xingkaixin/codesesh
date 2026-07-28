import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const indexHtmlPath = join(distDir, "index.html");
const distExists = existsSync(indexHtmlPath);

/**
 * Budget for what a first paint costs, in gzipped JavaScript. Generous enough
 * not to fail on ordinary feature work, tight enough that pulling a route's
 * heavy dependencies back into the entry trips it.
 */
const INITIAL_JS_GZIP_BUDGET_BYTES = 300_000;

/** Markers for dependencies that must only arrive with the route that needs them. */
const DEFERRED_DEPENDENCY_MARKERS = ["micromark", "mdast", "prism", "remark"];

function initialScripts(): string[] {
  const html = readFileSync(indexHtmlPath, "utf8");
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]!);
}

// Requires `pnpm --filter @codesesh/web build` to have run first.
describe.skipIf(!distExists)("CS-146: initial bundle", () => {
  it("stays within the gzipped budget", () => {
    const total = initialScripts().reduce(
      (bytes, path) => bytes + gzipSync(readFileSync(join(distDir, path.slice(1)))).length,
      0,
    );

    expect(total).toBeLessThan(INITIAL_JS_GZIP_BUDGET_BYTES);
  });

  it("does not preload markdown, syntax highlighting or the receipt", () => {
    const combined = initialScripts()
      .map((path) => readFileSync(join(distDir, path.slice(1)), "utf8").toLowerCase())
      .join("");

    for (const marker of DEFERRED_DEPENDENCY_MARKERS) {
      expect(combined).not.toContain(marker);
    }
  });

  it("still ships those dependencies in on-demand chunks", () => {
    const initial = new Set(initialScripts().map((path) => path.slice("/assets/".length)));
    const deferred = readdirSync(join(distDir, "assets"))
      .filter((file) => file.endsWith(".js") && !initial.has(file))
      .map((file) => readFileSync(join(distDir, "assets", file), "utf8").toLowerCase());

    // Deferred, not dropped: each marker still ships in some non-initial chunk.
    for (const marker of DEFERRED_DEPENDENCY_MARKERS) {
      expect(deferred.some((source) => source.includes(marker))).toBe(true);
    }
  });
});
