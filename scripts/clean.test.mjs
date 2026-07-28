import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLEANABLE_DIRECTORIES, resolveCleanTargets } from "./clean.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-clean-"));
  tempDirs.push(dir);
  return dir;
}

describe("CS-152: clean targets", () => {
  it("resolves every build output inside the workspace", () => {
    const dir = workspace();

    const targets = resolveCleanTargets(dir);

    expect(targets).toEqual(CLEANABLE_DIRECTORIES.map((name) => join(dir, name)));
  });

  it.each([
    ["a parent escape", "../dist"],
    ["the workspace itself", "."],
    ["an absolute path", join(tmpdir(), "elsewhere")],
  ])("refuses %s", (_name, target) => {
    const dir = workspace();

    expect(() => resolveCleanTargets(dir, [target])).toThrow(/Refusing to clean/);
  });

  it("removes only the declared outputs", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle.js"), "output");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "source");
    writeFileSync(join(dir, "package.json"), "{}");

    const { rmSync: remove } = await import("node:fs");
    for (const target of resolveCleanTargets(dir)) remove(target, { recursive: true, force: true });

    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });

  it("succeeds when the outputs are already gone", async () => {
    const dir = workspace();
    const { rmSync: remove } = await import("node:fs");

    for (const pass of [1, 2]) {
      expect(() => {
        for (const target of resolveCleanTargets(dir)) {
          remove(target, { recursive: true, force: true });
        }
      }, `pass ${pass}`).not.toThrow();
    }
  });
});
