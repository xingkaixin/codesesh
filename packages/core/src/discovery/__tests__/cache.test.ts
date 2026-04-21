import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getCacheInfo,
  loadCachedSessions,
  searchSessions,
  saveCachedSessions,
  syncSessionSearchIndex,
  type SessionCacheMeta,
} from "../cache.js";
import type { SessionData, SessionHead } from "../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

const now = Date.now();
const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), "scan-cache.json");
}

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: "/tmp/project",
    time_created: now,
    time_updated: now,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function makeSessionData(id: string, text: string): SessionData {
  const session = makeSession(id);
  return {
    ...session,
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        time_created: now,
        parts: [{ type: "text", text }],
      },
    ],
  };
}

beforeEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  dateNowSpy.mockReturnValue(now);
});

afterEach(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("loadCachedSessions", () => {
  it("returns null when cache db does not exist", () => {
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when agent is not cached", () => {
    saveCachedSessions("cursor", [makeSession("s1")]);
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when cache is too old", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    dateNowSpy.mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns cached sessions and meta when valid", () => {
    const meta: Record<string, SessionCacheMeta> = {
      s1: { id: "s1", sourcePath: "/path/to/source" },
    };

    saveCachedSessions("claudecode", [makeSession("s1")], meta);

    const result = loadCachedSessions("claudecode");
    expect(result).not.toBeNull();
    expect(result?.sessions).toHaveLength(1);
    expect(result?.sessions[0]?.id).toBe("s1");
    expect(result?.meta.s1?.sourcePath).toBe("/path/to/source");
    expect(result?.timestamp).toBe(now);
  });

  it("preserves empty cached results", () => {
    saveCachedSessions("claudecode", []);
    const result = loadCachedSessions("claudecode");
    expect(result).toEqual({
      sessions: [],
      meta: {},
      timestamp: now,
    });
  });
});

describe("saveCachedSessions", () => {
  it("creates sqlite cache db", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(readFileSync(getCachePath()).byteLength).toBeGreaterThan(0);
  });

  it("overwrites cached rows for the same agent", () => {
    saveCachedSessions("claudecode", [makeSession("old")]);
    saveCachedSessions("claudecode", [makeSession("new")]);

    const result = loadCachedSessions("claudecode");
    expect(result?.sessions.map((session) => session.id)).toEqual(["new"]);
  });

  it("preserves other agents", () => {
    saveCachedSessions("cursor", [makeSession("cursor-1")]);
    saveCachedSessions("claudecode", [makeSession("claude-1")]);

    expect(loadCachedSessions("cursor")?.sessions.map((session) => session.id)).toEqual([
      "cursor-1",
    ]);
    expect(loadCachedSessions("claudecode")?.sessions.map((session) => session.id)).toEqual([
      "claude-1",
    ]);
  });

  it("removes legacy json cache file after sqlite write", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getLegacyCachePath(), JSON.stringify({ stale: true }), "utf-8");

    saveCachedSessions("claudecode", [makeSession("s1")]);

    expect(() => readFileSync(getLegacyCachePath(), "utf-8")).toThrow();
  });
});

describe("clearCache", () => {
  it("clears sqlite rows", () => {
    saveCachedSessions("claudecode", [makeSession("s1")]);
    clearCache();
    expect(loadCachedSessions("claudecode")).toBeNull();
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("removes legacy json cache file", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getLegacyCachePath(), JSON.stringify({ stale: true }), "utf-8");
    clearCache();
    expect(() => readFileSync(getLegacyCachePath(), "utf-8")).toThrow();
  });
});

describe("getCacheInfo", () => {
  it("returns defaults when cache db does not exist", () => {
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("returns aggregate info from sqlite cache", () => {
    saveCachedSessions("agent1", [makeSession("a"), makeSession("b")]);
    saveCachedSessions("agent2", [makeSession("c")]);

    expect(getCacheInfo()).toEqual({ lastScanTime: now, size: 3 });
  });
});

describe("searchSessions", () => {
  it("indexes session content and returns highlighted matches", () => {
    const session = makeSession("s1");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "sqlite fts search is now enabled"),
    );

    const results = searchSessions("sqlite");
    expect(results).toHaveLength(1);
    expect(results[0]?.agentName).toBe("claudecode");
    expect(results[0]?.session.id).toBe("s1");
    expect(results[0]?.snippet).toContain("<mark>sqlite</mark>");
  });

  it("supports OR queries and agent filters", () => {
    const alpha = makeSession("alpha");
    const beta = makeSession("beta");
    saveCachedSessions("claudecode", [alpha]);
    saveCachedSessions("cursor", [beta]);
    syncSessionSearchIndex("claudecode", [alpha], (sessionId) =>
      makeSessionData(sessionId, "search alpha term"),
    );
    syncSessionSearchIndex("cursor", [beta], (sessionId) =>
      makeSessionData(sessionId, "search beta term"),
    );

    const allResults = searchSessions("alpha OR beta");
    expect(allResults).toHaveLength(2);

    const filteredResults = searchSessions("alpha OR beta", { agent: "cursor" });
    expect(filteredResults).toHaveLength(1);
    expect(filteredResults[0]?.agentName).toBe("cursor");
  });
});
