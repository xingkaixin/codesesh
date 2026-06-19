import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSessionSource, FileSystemSessionSource } from "../base.js";
import type { AgentScanOptions, SessionCacheMeta, SessionSourceRef } from "../base.js";
import type { SessionData, SessionHead } from "../../types/index.js";

interface FakeSource {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
  head: SessionHead | null;
}

/**
 * In-memory file-system source for exercising the shared change detection
 * algorithm without touching the disk. Only the two primitives are faked.
 */
class FakeFileSystemSource extends FileSystemSessionSource {
  readonly name = "fake";
  readonly displayName = "Fake";

  constructor(private sources: FakeSource[] = []) {
    super();
  }

  setSources(sources: FakeSource[]): void {
    this.sources = sources;
  }

  isAvailable(): boolean {
    return true;
  }

  scan(): SessionHead[] {
    return this.sources.map((s) => s.head).filter((h): h is SessionHead => h !== null);
  }

  getSessionData(_sessionId: string): SessionData {
    return {} as SessionData;
  }

  listSessionSources(): SessionSourceRef[] {
    return this.sources.map((s) => ({
      sessionId: s.sessionId,
      sourcePath: s.sourcePath,
      fingerprint: s.fingerprint,
    }));
  }

  scanSessionSource(sourcePath: string): SessionHead | null {
    const found = this.sources.find((s) => s.sourcePath === sourcePath);
    if (!found || !found.head) return null;
    this.sessionMetaMap.set(found.sessionId, {
      id: found.sessionId,
      sourcePath: found.sourcePath,
      sourceFingerprint: found.fingerprint,
    });
    return found.head;
  }
}

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `fake/${id}`,
    title: id,
    directory: "/tmp",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function source(id: string, fingerprint = "fp-1", overrides: Partial<FakeSource> = {}): FakeSource {
  return {
    sessionId: id,
    sourcePath: `/tmp/${id}.jsonl`,
    fingerprint,
    head: makeSession(id),
    ...overrides,
  };
}

describe("BaseAgent", () => {
  it("getUri returns correct format", () => {
    const agent = new FakeFileSystemSource();
    expect(agent.getUri("abc123")).toBe("fake://abc123");
  });
});

describe("FileSystemSessionSource.checkForChanges", () => {
  it("reports no changes when fingerprints and paths match", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    // Seed metaMap as if a prior scan populated it.
    agent.scanSessionSource("/tmp/a.jsonl");
    agent.scanSessionSource("/tmp/b.jsonl");

    const result = agent.checkForChanges(Date.now(), [makeSession("a"), makeSession("b")]);
    expect(result.hasChanges).toBe(false);
    expect(result.changedIds).toEqual([]);
  });

  it("detects added sources", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    agent.scanSessionSource("/tmp/a.jsonl");

    const result = agent.checkForChanges(Date.now(), [makeSession("a")]);
    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["b"]);
  });

  it("detects removed sources", () => {
    const agent = new FakeFileSystemSource([source("a")]);
    agent.scanSessionSource("/tmp/a.jsonl");

    const result = agent.checkForChanges(Date.now(), [makeSession("a"), makeSession("ghost")]);
    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["ghost"]);
  });

  it("detects changed fingerprints", () => {
    const agent = new FakeFileSystemSource([source("a", "fp-2")]);
    // Cached meta still carries the old fingerprint.
    agent.getSessionMetaMap().set("a", {
      id: "a",
      sourcePath: "/tmp/a.jsonl",
      sourceFingerprint: "fp-1",
    });

    const result = agent.checkForChanges(Date.now(), [makeSession("a")]);
    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["a"]);
  });

  it("detects changed source paths even with identical fingerprints", () => {
    const agent = new FakeFileSystemSource([source("a", "fp-1")]);
    agent.getSessionMetaMap().set("a", {
      id: "a",
      sourcePath: "/tmp/old-a.jsonl",
      sourceFingerprint: "fp-1",
    });

    const result = agent.checkForChanges(Date.now(), [makeSession("a")]);
    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["a"]);
  });

  it("treats missing fingerprint as changed", () => {
    const agent = new FakeFileSystemSource([source("a")]);
    agent.getSessionMetaMap().set("a", { id: "a", sourcePath: "/tmp/a.jsonl" });

    const result = agent.checkForChanges(Date.now(), [makeSession("a")]);
    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["a"]);
  });
});

describe("FileSystemSessionSource.incrementalScan", () => {
  it("re-parses changed sources and merges into cached sessions", () => {
    const agent = new FakeFileSystemSource([
      source("a", "fp-1", { head: makeSession("a") }),
      source("b", "fp-1", { head: makeSession("b") }),
    ]);

    const updated = agent.incrementalScan([makeSession("a"), makeSession("b")], ["a"]);
    expect(updated.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(agent.getSessionMetaMap().get("a")?.sourceFingerprint).toBe("fp-1");
  });

  it("adds new sources when listed but missing from cache", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    const updated = agent.incrementalScan([makeSession("a")], ["b"]);
    expect(updated.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("drops sources that no longer parse", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b", "fp-1", { head: null })]);
    const updated = agent.incrementalScan([makeSession("a"), makeSession("b")], ["b"]);
    expect(updated.map((s) => s.id)).toEqual(["a"]);
    expect(agent.getSessionMetaMap().has("b")).toBe(false);
  });
});

describe("DatabaseSessionSource", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-db-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.vscdb");
    writeFileSync(dbPath, "init");
    return dbPath;
  }

  class FakeDatabaseSource extends DatabaseSessionSource {
    readonly name = "fakedb";
    readonly displayName = "Fake DB";
    scanCount = 0;

    constructor(private dbPath: string | null) {
      super();
    }

    isAvailable(): boolean {
      return true;
    }

    scan(_options?: AgentScanOptions): SessionHead[] {
      this.scanCount += 1;
      return [makeSession("db-1")];
    }

    getSessionData(_sessionId: string): SessionData {
      return {} as SessionData;
    }

    protected getDatabasePath(): string | null {
      return this.dbPath;
    }
  }

  it("flags all sessions as changed when db mtime advances past since", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1")];

    // since far in the future → no changes
    const fresh = agent.checkForChanges(Date.now() + 1_000_000, cached);
    expect(fresh.hasChanges).toBe(false);
    expect(fresh.changedIds).toEqual([]);
  });

  it("reports changes when db mtime is newer than since", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1"), makeSession("db-2")];

    const stale = agent.checkForChanges(0, cached);
    expect(stale.hasChanges).toBe(true);
    expect(stale.changedIds).toEqual(["db-1", "db-2"]);
  });

  it("reports no changes when database path is missing", () => {
    const agent = new FakeDatabaseSource(null);
    const result = agent.checkForChanges(0, [makeSession("db-1")]);
    expect(result.hasChanges).toBe(false);
  });

  it("incrementalScan delegates to a full scan", () => {
    const agent = new FakeDatabaseSource(makeDb());
    const sessions = agent.incrementalScan([makeSession("stale")], ["stale"]);
    expect(agent.scanCount).toBe(1);
    expect(sessions.map((s) => s.id)).toEqual(["db-1"]);
  });

  it("rememberSession records meta keyed by db path", () => {
    const agent = new FakeDatabaseSource("/tmp/fake.db") as FakeDatabaseSource & {
      rememberSession(id: string): void;
    };
    agent.rememberSession("db-1");
    const meta: SessionCacheMeta | undefined = agent.getSessionMetaMap().get("db-1");
    expect(meta?.sourcePath).toBe("/tmp/fake.db");
  });
});
