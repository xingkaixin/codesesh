import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distEntry = join(dirname(fileURLToPath(import.meta.url)), "../../../dist/contract/index.mjs");
const testFixturesEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../dist/test-fixtures.mjs",
);
const distExists = existsSync(distEntry);
const testFixturesExist = existsSync(testFixturesEntry);

// Requires `pnpm --filter @codesesh/core build` to have run first — the
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

  it.skipIf(!distExists)("imports cleanly and exposes only pure runtime values", async () => {
    const contract = await import(distEntry);
    expect(Object.keys(contract).sort()).toEqual(
      [
        "AGENT_CATALOG",
        "PROJECT_IDENTITY_KINDS",
        "UNKNOWN_AGENT_NAME",
        "addCalendarDays",
        "agentRoutePath",
        "applySessionChanges",
        "applySessionWindowChanges",
        "assertIdentifiedSessionHead",
        "assertSessionIdentity",
        "buildSessionTree",
        "createSessionProjectionContext",
        "compareSessionActivityDesc",
        "countCalendarDays",
        "createSessionIdentity",
        "createSessionIndex",
        "filterSessionTreeByActivityWindow",
        "filterSessionTreeEntriesByActivityWindow",
        "formatSessionReference",
        "getProjectAgentKey",
        "getProjectIdentityKey",
        "getSessionAgentKey",
        "getSessionRouteKey",
        "getSessionRoutePath",
        "groupSessionsByCalendarDay",
        "getAgentCatalogEntry",
        "isProjectIdentityKind",
        "matchesProjectIdentity",
        "mergeSessionsUpdatedEvents",
        "mergeSortedSessions",
        "normalizeMessageParts",
        "normalizeSessionReference",
        "parseSessionReference",
        "sessionRoutePath",
        "sortSessionsByActivity",
        "startOfCalendarDay",
        "toCalendarDayKey",
        "updateSessionIndex",
      ].sort(),
    );
  });

  it.skipIf(!testFixturesExist)("exposes fixtures from the explicit test-only entry", async () => {
    const fixtures = await import(testFixturesEntry);

    expect(Object.keys(fixtures).sort()).toEqual(
      [
        "SAMPLE_DASHBOARD_DATA",
        "SAMPLE_SCAN_STATUS_EVENT",
        "SAMPLE_SESSIONS_UPDATED_EVENT",
        "SAMPLE_SESSION_HEAD",
      ].sort(),
    );
  });
});
