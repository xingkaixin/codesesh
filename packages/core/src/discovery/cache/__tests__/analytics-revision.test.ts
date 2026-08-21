import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-analytics-revision-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

import {
  advanceAnalyticsRevision,
  getAnalyticsRevision,
  readAnalyticsRevision,
} from "../analytics-revision.js";
import { getCachePath, setSchemaEnsuredPath } from "../db.js";
import { withCacheDb } from "../connection.js";
import { commitDurableSessionPublication } from "../publication.js";
import { clearCache, saveCachedSessionChanges, saveCachedSessions } from "../sessions.js";
import { syncSessionSearchIndex, syncSessionSearchIndexChanges } from "../search.js";
import { openDbReadOnly } from "../../../utils/sqlite.js";
import { makeSessionData, makeSessionHead } from "./fixtures.js";

function cacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(cacheDir(), { recursive: true, force: true });
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(cacheDir(), { recursive: true, force: true });
});

describe("analytics revision", () => {
  it("advances for durable session, message, activity, and deletion commits", () => {
    const session = makeSessionHead("one");
    const detail = {
      ...makeSessionData(session.reference.sessionId),
      messages: [
        {
          id: "one-message",
          role: "assistant" as const,
          time_created: 1,
          model: "gpt-5",
          cost: 1,
          parts: [
            {
              type: "tool" as const,
              tool: "write",
              state: { status: "completed" as const, input: { path: "src/index.ts" } },
            },
          ],
        },
      ],
    };

    expect(getAnalyticsRevision()).toBeNull();
    expect(saveCachedSessions("codex", [session])).toBe(true);
    expect(getAnalyticsRevision()).toBe("1");

    expect(syncSessionSearchIndex("codex", [session], () => detail)).toMatchObject({
      indexed: 1,
    });
    expect(getAnalyticsRevision()).toBe("2");

    expect(
      syncSessionSearchIndexChanges("codex", [], [session.reference.sessionId], () => detail),
    ).toMatchObject({
      deleted: 1,
    });
    expect(getAnalyticsRevision()).toBe("3");
  });

  it("does not advance for an empty change set or a rolled-back transaction", () => {
    const session = makeSessionHead("one");
    saveCachedSessions("codex", [session]);
    expect(getAnalyticsRevision()).toBe("1");

    expect(saveCachedSessionChanges("codex", [], [])).toBe(true);
    expect(getAnalyticsRevision()).toBe("1");

    withCacheDb((db) => {
      expect(() =>
        db
          .transaction(() => {
            advanceAnalyticsRevision(db);
            throw new Error("rollback");
          })
          .immediate(),
      ).toThrow("rollback");
    });
    expect(getAnalyticsRevision()).toBe("1");
  });

  it("advances once when a durable publication commits both cache layers", () => {
    const session = makeSessionHead("one");

    expect(
      commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions: [session],
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        () => makeSessionData(session.reference.sessionId),
      ),
    ).toMatchObject({ status: "committed", searchIndex: { indexed: 1 } });
    expect(getAnalyticsRevision()).toBe("1");
  });

  it("is shared by independent database connections and survives cache clearing", () => {
    const session = makeSessionHead("one");
    saveCachedSessions("codex", [session]);
    const secondConnection = openDbReadOnly(getCachePath());
    expect(secondConnection).not.toBeNull();

    try {
      expect(readAnalyticsRevision(secondConnection!)).toBe("1");
      saveCachedSessionChanges(
        "codex",
        [{ session: { ...session, title: "Updated" }, sortIndex: 0 }],
        [],
      );
      expect(readAnalyticsRevision(secondConnection!)).toBe("2");
    } finally {
      secondConnection?.close();
    }

    clearCache();
    expect(getAnalyticsRevision()).toBe("3");
    const freshConnection = openDbReadOnly(getCachePath());
    try {
      expect(readAnalyticsRevision(freshConnection!)).toBe("3");
    } finally {
      freshConnection?.close();
    }
  });
});
