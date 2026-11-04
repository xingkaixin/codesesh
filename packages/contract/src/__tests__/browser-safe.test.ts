import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distEntry = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.mjs");
const distExists = existsSync(distEntry);

// Requires `pnpm --filter @codesesh/contract build` to have run first — the
// contract package runtime must remain browser-safe.
describe("contract browser-safety", () => {
  it.skipIf(!distExists)(
    "bundle contains no Node built-ins, better-sqlite3, or agent registration side effects",
    () => {
      const source = readFileSync(distEntry, "utf8");
      expect(source).not.toContain("node:");
      expect(source).not.toContain("better-sqlite3");
      expect(source).not.toContain("register");
    },
  );
});
