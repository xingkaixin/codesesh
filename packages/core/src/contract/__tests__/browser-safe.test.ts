import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distEntry = join(dirname(fileURLToPath(import.meta.url)), "../../../dist/contract/index.mjs");
const distExists = existsSync(distEntry);

// Requires `pnpm --filter @codesesh/core build` to have run first — the
// contract package has no runtime code of its own to test against otherwise.
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

  it.skipIf(!distExists)("imports cleanly and exposes only pure fixture data", async () => {
    const contract = await import(distEntry);
    expect(Object.keys(contract).sort()).toEqual(
      [
        "SAMPLE_DASHBOARD_DATA",
        "SAMPLE_SCAN_STATUS_EVENT",
        "SAMPLE_SESSIONS_UPDATED_EVENT",
        "SAMPLE_SESSION_HEAD",
      ].sort(),
    );
  });
});
