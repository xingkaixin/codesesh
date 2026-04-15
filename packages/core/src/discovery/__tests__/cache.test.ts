import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  loadCachedSessions,
  saveCachedSessions,
  clearCache,
  getCacheInfo,
  type SessionCacheMeta,
} from "../cache.js";
import type { SessionHead } from "../../types/index.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

const now = Date.now();
vi.spyOn(Date, "now").mockReturnValue(now);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    time_created: now,
    time_updated: now,
  };
}

describe("loadCachedSessions", () => {
  it("returns null when cache file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json");
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null on version mismatch", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ version: 1, entries: {}, lastScanTime: now }),
    );
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when agent not in cache", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ version: 2, entries: {}, lastScanTime: now }),
    );
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns null when cache is too old (>7 days)", () => {
    const oldTimestamp = now - 8 * 24 * 60 * 60 * 1000;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 2,
        entries: {
          claudecode: {
            sessions: [makeSession("s1")],
            meta: {},
            timestamp: oldTimestamp,
            version: 2,
          },
        },
        lastScanTime: oldTimestamp,
      }),
    );
    expect(loadCachedSessions("claudecode")).toBeNull();
  });

  it("returns cached sessions when valid", () => {
    const session = makeSession("s1");
    const meta: Record<string, SessionCacheMeta> = {
      s1: { id: "s1", sourcePath: "/path" },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 2,
        entries: {
          claudecode: { sessions: [session], meta, timestamp: now, version: 2 },
        },
        lastScanTime: now,
      }),
    );
    const result = loadCachedSessions("claudecode");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0]!.id).toBe("s1");
    expect(result!.meta.s1.sourcePath).toBe("/path");
  });
});

describe("saveCachedSessions", () => {
  it("creates new cache when file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    saveCachedSessions("claudecode", [makeSession("s1")]);
    expect(mockedMkdirSync).toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0]![1] as string);
    expect(written.version).toBe(2);
    expect(written.entries.claudecode.sessions).toHaveLength(1);
  });

  it("resets cache when existing file has wrong version", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ version: 1, entries: { old: {} }, lastScanTime: 0 }),
    );
    saveCachedSessions("claudecode", [makeSession("s1")]);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0]![1] as string);
    // Old entries should be cleared
    expect(Object.keys(written.entries)).toEqual(["claudecode"]);
  });

  it("overwrites existing entry for same agent", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 2,
        entries: {
          other: { sessions: [], meta: {}, timestamp: now, version: 2 },
          claudecode: {
            sessions: [makeSession("old")],
            meta: {},
            timestamp: now - 1000,
            version: 2,
          },
        },
        lastScanTime: now - 1000,
      }),
    );
    saveCachedSessions("claudecode", [makeSession("new")]);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0]![1] as string);
    expect(written.entries.claudecode.sessions[0].id).toBe("new");
    // Other agent preserved
    expect(written.entries.other).toBeDefined();
  });

  it("silently ignores write errors", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    expect(() => saveCachedSessions("claudecode", [makeSession("s1")])).not.toThrow();
  });
});

describe("clearCache", () => {
  it("writes empty entries when cache exists", () => {
    mockedExistsSync.mockReturnValue(true);
    clearCache();
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0]![1] as string);
    expect(written.entries).toEqual({});
    expect(written.lastScanTime).toBe(0);
  });

  it("does nothing when cache does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    clearCache();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("getCacheInfo", () => {
  it("returns defaults when cache does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });

  it("returns info from valid cache", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 2,
        entries: {
          agent1: {
            sessions: [makeSession("a"), makeSession("b")],
            meta: {},
            timestamp: now,
            version: 2,
          },
          agent2: { sessions: [makeSession("c")], meta: {}, timestamp: now, version: 2 },
        },
        lastScanTime: now,
      }),
    );
    const info = getCacheInfo();
    expect(info.lastScanTime).toBe(now);
    expect(info.size).toBe(3);
  });

  it("returns defaults on invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("bad json");
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });
});
