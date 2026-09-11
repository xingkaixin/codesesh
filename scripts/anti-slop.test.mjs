import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const directories = [];

function runTool(args) {
  const { executable, shell } = getPnpmInvocation();
  const result = spawnSync(executable, ["exec", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell,
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function fixture(code, ruleNames, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codesesh-anti-slop-"));
  directories.push(directory);
  const path = join(directory, "fixture.ts");
  const config = join(directory, ".oxlintrc.json");
  writeFileSync(path, code);
  writeFileSync(
    config,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [
        { name: "anti-slop", specifier: join(repoRoot, "tools/oxlint/anti-slop/index.ts") },
      ],
      options: policy.options,
      rules: {
        ...Object.fromEntries(
          ruleNames.map((name) => [`anti-slop/${name}`, policy.rules[`anti-slop/${name}`]]),
        ),
        ...overrides,
      },
    }),
  );
  const lint = (fix = false) => {
    const result = runTool([
      "oxlint",
      "--config",
      config,
      "--no-ignore",
      "--format",
      "json",
      ...(fix ? ["--fix"] : []),
      path,
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.number_of_files).toBe(1);
    expect(result.status).toBe(
      report.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0,
    );
    return report.diagnostics;
  };
  return { path, lint };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("vendored anti-slop policy", { timeout: 30_000 }, () => {
  it("permits raw unknown dictionaries but rejects other erased value contracts and aliases", () => {
    const allowed = fixture(
      `
      type Raw = Record<string, unknown>;
      type Domain = Record<string, { name: string }>;
      type Mixed = { [key: string]: unknown | string };
    `,
      ["no-unsafe-dictionary-type"],
    );
    expect(allowed.lint()).toEqual([]);
    const rejected = fixture(
      `
      type Escape = any;
      type Aliased = Record<string, Escape>;
      type ObjectValues = { [key: string]: object };
      type EmptyValues = Record<string, {} | string>;
    `,
      ["no-unsafe-dictionary-type"],
    );
    expect(rejected.lint().map((diagnostic) => diagnostic.code)).toEqual(
      Array(3).fill("anti-slop(no-unsafe-dictionary-type)"),
    );
    const upstreamDefault = fixture(
      "type Raw = Record<string, unknown>;",
      ["no-unsafe-dictionary-type"],
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(upstreamDefault.lint()).toHaveLength(1);
  });

  it("preserves concrete object and dictionary contracts while rejecting known value erasure", () => {
    const checked = fixture(
      `
      const named: { name: string } = { name: "one" };
      const indexed: Record<string, { name: string }> = { one: { name: "one" } };
      type Erased = unknown;
      type Dictionary<T> = Record<string, T>;
      const precise: Dictionary<{ name: string }> = { one: { name: "one" } };
      const broad: Dictionary<unknown> = { name: "one" };
      const alias: Erased = { name: "one" };
      const erased: unknown = { name: "one" };
      const raw: Record<string, unknown> = { name: "one" };
    `,
      ["no-known-value-widening"],
    );
    expect(checked.lint().map((diagnostic) => diagnostic.code)).toEqual(
      Array(4).fill("anti-slop(no-known-value-widening)"),
    );
  });

  it("requires justifications for any, never, nested escapes and chains without requiring ordinary casts", () => {
    const checked = fixture(
      `
      declare const value: unknown;
      const ordinary = value as { name: string };
      const constant = "one" as const;
      const anyValue = value as any;
      const neverValue = value as never;
      const nested = value as { items: any[] };
      const chained = (value as unknown) as string;
      const angle = <never>value;
    `,
      ["require-safety-comment-for-type-assertion"],
    );
    expect(checked.lint()).toHaveLength(5);
    const upstreamDefault = fixture(
      "declare const value: unknown; const ordinary = value as string;",
      ["require-safety-comment-for-type-assertion"],
      { "anti-slop/require-safety-comment-for-type-assertion": "error" },
    );
    expect(upstreamDefault.lint()).toHaveLength(1);
  });

  it("keeps justified exceptions local and reports stale suppressions", () => {
    const checked = fixture(
      `
      declare const value: unknown;
      // SAFETY: The fixture supplies the only field read by this boundary.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Partial boundary fixture.
      const fixture = value as unknown as string;
      const next = value as any;
      // oxlint-disable-next-line anti-slop/no-module-mocking -- Control worker lifecycle events.
      vi.mock("node:worker_threads", () => ({}));
      vi.mock("./owned-module", () => ({}));
      // oxlint-disable-next-line anti-slop/no-module-mocking -- No mock remains here.
      const stale = 1;
    `,
      [
        "require-safety-comment-for-type-assertion",
        "no-chained-type-assertions",
        "no-module-mocking",
      ],
    );
    const diagnostics = checked.lint();
    expect(diagnostics).toHaveLength(3);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "anti-slop(require-safety-comment-for-type-assertion)",
      ),
    ).toBe(true);
    expect(
      diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(no-module-mocking)"),
    ).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("Unused"))).toBe(true);
  });

  it("separates module declarations, retains JSDoc and overloads, and stabilizes with oxfmt", () => {
    const checked = fixture(
      `import type { A } from "a";
import type { B } from "b";
/** Attached to Value. */
export interface Value { name: string; }
export function parse(value: string): string;
export function parse(value: number): number;
export function parse(value: string | number) {
  const current = value;
  if (current) return current;
  return value;
}
export type Result = Value;
`,
      ["require-readable-spacing"],
    );
    expect(checked.lint().length).toBeGreaterThan(0);
    checked.lint(true);
    expect(runTool(["oxfmt", "--write", checked.path]).status).toBe(0);
    const first = readFileSync(checked.path, "utf8");
    expect(first).toContain(
      'import type { B } from "b";\n\n/** Attached to Value. */\nexport interface Value',
    );
    expect(first).toContain(
      "export function parse(value: string): string;\nexport function parse(value: number): number;\nexport function parse(value: string | number)",
    );
    expect(first).toContain(
      "  const current = value;\n  if (current) return current;\n  return value;",
    );
    expect(checked.lint()).toEqual([]);
    checked.lint(true);
    expect(runTool(["oxfmt", "--write", checked.path]).status).toBe(0);
    expect(readFileSync(checked.path, "utf8")).toBe(first);
  });
});
