import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseSessionSource,
  diffSessionSources,
  FileSystemSessionSource,
  filteredSession,
  SingleFileSessionSource,
} from "../base.js";
import type {
  AgentScanOptions,
  FileSessionMeta,
  SessionCacheMeta,
  SessionSourceFile,
  SessionSourceRef,
  SessionSourceSynchronizationRequest,
} from "../base.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";
import { PRICING_CAPTURE_EPOCH } from "../../pricing/cost.js";
import type { ModelPricing } from "../../pricing/fetcher.js";
import { pricingResolver } from "../../pricing/resolver.js";
import { estimateTokenCost } from "../../utils/cost.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

interface FakeSource {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
  head: SessionHead | null;
  throws?: boolean;
  error?: Error;
  filtered?: boolean;
}

/**
 * In-memory file-system source for exercising the shared change detection
 * algorithm without touching the disk. Only the two primitives are faked.
 */
class FakeFileSystemSource extends FileSystemSessionSource {
  readonly name: string = "fake";
  readonly displayName = "Fake";
  lastScanOptions: AgentScanOptions | undefined;

  constructor(private sources: FakeSource[] = []) {
    super();
  }

  setSources(sources: FakeSource[]): void {
    this.sources = sources;
  }

  walk(root: string) {
    return this.walkFiles(root, () => true);
  }

  sessionIdentityForTest(sessionId: string) {
    return this.sessionIdentity(sessionId);
  }

  isAvailable(): boolean {
    return true;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "in-memory test source" };
  }

  getSessionData(_sessionId: string): SessionDetail {
    return {} as SessionDetail;
  }

  listSessionSources(): SessionSourceRef[] {
    return this.sources.map((s) => ({
      sessionId: s.sessionId,
      sourcePath: s.sourcePath,
      fingerprint: s.fingerprint,
    }));
  }

  scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null {
    this.lastScanOptions = options;
    const found = this.sources.find((s) => s.sourcePath === sourcePath);
    if (found?.error) throw found.error;
    if (found?.throws) throw new Error("parse failed");
    if (!found || !found.head) return null;
    this.sessionMetaMap.set(found.sessionId, {
      id: found.sessionId,
      sourcePath: found.sourcePath,
      sourceFingerprint: found.fingerprint,
    });
    return found.head;
  }

  protected override scanSessionSourceResult(ref: SessionSourceRef, options?: AgentScanOptions) {
    const found = this.sources.find((item) => item.sourcePath === ref.sourcePath);
    if (found?.filtered) return filteredSession<SessionHead>("no visible messages");
    return super.scanSessionSourceResult(ref, options);
  }
}

class NormalizedNameSource extends FakeFileSystemSource {
  override readonly name = " FaKe ";
}

function synchronizeFileSource(
  agent: FakeFileSystemSource,
  sessions: SessionHead[],
  request: SessionSourceSynchronizationRequest,
) {
  return agent.sessionSourceAccess.synchronize(
    { sessions, meta: agent.snapshotSessionCacheMeta() },
    request,
  );
}

class ReentrantSingleFileSource extends SingleFileSessionSource {
  readonly name = "reentrant";
  readonly displayName = "Reentrant";
  readonly source = {
    sessionId: "filtered",
    sourcePath: "/tmp/filtered.jsonl",
    fingerprint: "fp-1",
  };
  nestedOutcomeStatus: string | undefined;
  private parsing = false;

  isAvailable(): boolean {
    return true;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "in-memory test source" };
  }

  getSessionData(_sessionId: string): SessionDetail {
    return {} as SessionDetail;
  }

  listSessionSources(): SessionSourceRef[] {
    return [this.source];
  }

  protected override parseFileSessionHeadResult() {
    if (this.parsing) return filteredSession<SessionHead>("nested filter");
    this.parsing = true;
    this.nestedOutcomeStatus = this.scanSessionSourceOutcome(this.source).status;
    return filteredSession<SessionHead>("outer filter");
  }

  protected createFileSessionMeta(head: SessionHead, source: SessionSourceFile): FileSessionMeta {
    return this.buildFileSessionMeta({ head, source, fingerprint: "fp-1", extras: {} });
  }
}

function makeSession(id: string): SessionHead {
  return {
    reference: { agentName: "fake", sessionId: id },
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

const TEST_PRICING: ModelPricing = {
  inputCostPerToken: 0.001,
  outputCostPerToken: 0.002,
  cacheCreateCostPerToken: 0,
  cacheReadCostPerToken: 0,
  reasoningCostPerToken: 0,
  webSearchCostPerRequest: 0,
};

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

  it("normalizes session references from its registered identity", () => {
    const agent = new NormalizedNameSource();
    expect(agent.sessionIdentityForTest("nested/session")).toEqual({
      reference: { agentName: "fake", sessionId: "nested/session" },
    });
  });
});

describe("FileSystemSessionSource.scan", () => {
  it("keeps a rich parse result isolated during a nested scan of the same source", () => {
    const agent = new ReentrantSingleFileSource();

    const outcome = agent.scanSessionSourceOutcome(agent.source);

    expect(agent.nestedOutcomeStatus).toBe("filtered");
    expect(outcome).toMatchObject({ status: "filtered", reason: "outer filter" });
  });

  it("ignores a session-file symlink outside the scan root", () => {
    const directory = mkdtempSync(join(tmpdir(), "codesesh-walk-symlink-"));
    const root = join(directory, "root");
    const target = join(directory, "outside.jsonl");
    const link = join(root, "linked.jsonl");
    try {
      mkdirSync(root);
      writeFileSync(target, "outside");
      symlinkSync(target, link);

      expect(new FakeFileSystemSource().walk(root)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("raises a root-level failure when source enumeration cannot complete", () => {
    const agent = new FakeFileSystemSource();
    try {
      agent.walk("invalid\0root");
      expect.unreachable("source enumeration should fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "SessionScanError",
        agentName: "fake",
        stage: "enumerating session sources",
        sourcePath: "invalid\0root",
      });
    }
  });

  it("scans listed sources and reports progress while skipping invalid entries", () => {
    const agent = new FakeFileSystemSource([
      source("a"),
      source("invalid", "fp-1", { head: null }),
      source("b"),
    ]);
    const progress: Array<{ total?: number; processed?: number; sessions?: number }> = [];

    const options = {
      fast: true,
      onProgress: (update: (typeof progress)[number]) => progress.push(update),
    };
    const sessions = agent.scan(options);

    expect(sessions.map((session) => session.reference.sessionId)).toEqual(["a", "b"]);
    expect(agent.lastScanOptions).toBe(options);
    expect(progress).toEqual([
      { total: 3, processed: 0, sessions: 0 },
      { total: 3, processed: 1, sessions: 1 },
      { total: 3, processed: 2, sessions: 1 },
      { total: 3, processed: 3, sessions: 2 },
    ]);
  });

  it("reports a failed source outcome via diagnostics when parsing throws", () => {
    const agent = new FakeFileSystemSource([
      source("a"),
      source("broken", "fp-1", { throws: true }),
    ]);
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const diagnostics: CoreDiagnostics = {
      warn: (event, detail) => events.push({ event, detail }),
    };
    setCoreDiagnostics(diagnostics);

    try {
      const sessions = agent.scan();
      expect(sessions.map((session) => session.reference.sessionId)).toEqual(["a"]);
      expect(events).toEqual([
        {
          event: "agent.session_source_outcome",
          detail: {
            agent: "fake",
            session_id: "broken",
            source_path: "/tmp/broken.jsonl",
            outcome: "failed",
            stage: "parsing",
            error_class: "Error",
            message: "parse failed",
          },
        },
      ]);
    } finally {
      setCoreDiagnostics(null);
    }
  });
});

describe("FileSystemSessionSource pricing miss capture", () => {
  class UnpricedModelSource extends FakeFileSystemSource {
    override scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null {
      estimateTokenCost("vendor/nonexistent-model", { input: 10, output: 10 });
      return super.scanSessionSource(sourcePath, options);
    }
  }

  it("records models the head parse could not price into the session meta", () => {
    const src = source("a");
    const agent = new UnpricedModelSource([src]);

    const outcome = agent.scanSessionSourceOutcome({
      sessionId: src.sessionId,
      sourcePath: src.sourcePath,
      fingerprint: src.fingerprint,
    });

    expect(outcome.status).toBe("parsed");
    expect(agent.getSessionCacheMeta("a")?.unpricedModels).toEqual(["vendor/nonexistent-model"]);
    expect(agent.getSessionCacheMeta("a")?.pricingCaptureEpoch).toBe(PRICING_CAPTURE_EPOCH);
  });

  it("leaves no recorded misses when every model is priced", () => {
    const src = source("a");
    const agent = new FakeFileSystemSource([src]);

    agent.scanSessionSourceOutcome({
      sessionId: src.sessionId,
      sourcePath: src.sourcePath,
      fingerprint: src.fingerprint,
    });

    expect(agent.getSessionCacheMeta("a")?.unpricedModels).toBeUndefined();
  });
});

describe("session cache metadata ownership", () => {
  it("isolates restored, single-value, and snapshot metadata from callers", () => {
    const restored = {
      a: { id: "a", sourcePath: "/tmp/a.jsonl", unpricedModels: ["vendor/model"] },
    };
    const agent = new FakeFileSystemSource([]);

    agent.restoreSessionCacheMeta(restored);
    restored.a.sourcePath = "/mutated-input";

    const value = agent.getSessionCacheMeta("a")!;
    value.sourcePath = "/mutated-value";
    value.unpricedModels?.push("vendor/other");

    const snapshot = agent.snapshotSessionCacheMeta();
    snapshot.a!.sourcePath = "/mutated-snapshot";

    expect(agent.getSessionCacheMeta("a")).toEqual({
      id: "a",
      sourcePath: "/tmp/a.jsonl",
      unpricedModels: ["vendor/model"],
    });
  });
});

describe("diffSessionSources", () => {
  function ref(
    id: string,
    fingerprint = "fp-1",
    sourcePath = `/tmp/${id}.jsonl`,
  ): SessionSourceRef {
    return { sessionId: id, sourcePath, fingerprint };
  }

  function meta(id: string, overrides: Partial<SessionCacheMeta> = {}): SessionCacheMeta {
    return {
      id,
      sourcePath: `/tmp/${id}.jsonl`,
      sourceFingerprint: "fp-1",
      pricingCaptureEpoch: PRICING_CAPTURE_EPOCH,
      ...overrides,
    };
  }

  it("reads cached meta from a plain object", () => {
    const refs = [ref("a"), ref("b", "fp-2")];
    const cached = [makeSession("a"), makeSession("b")];
    const entries = { a: meta("a"), b: meta("b") };

    const diff = diffSessionSources(refs, cached, entries);

    expect(diff).toEqual({
      changedIds: ["b"],
      removedIds: [],
      failedIds: [],
      sourceOutcomes: [],
    });
  });

  it("treats a differing fingerprint as changed even when the mtime is unchanged", () => {
    // Agents put their head-index and parser versions in the fingerprint so a
    // version bump invalidates cached heads; matching mtimes must not override it.
    const diff = diffSessionSources(
      [ref("a", '["head-v1","parser-v2",42,7,null]')],
      [makeSession("a")],
      {
        a: meta("a", { sourceFingerprint: '["head-v1","parser-v1",42,7,null]', sourceMtimeMs: 42 }),
      },
    );

    expect(diff).toEqual({
      changedIds: ["a"],
      removedIds: [],
      failedIds: [],
      sourceOutcomes: [],
    });
  });

  it("re-parses a cached head once one of its unpriced models gains pricing", () => {
    const diff = diffSessionSources([ref("a")], [makeSession("a")], {
      a: meta("a", { unpricedModels: ["vendor/nonexistent-model", "claude-sonnet-4-6"] }),
    });

    expect(diff.changedIds).toEqual(["a"]);
  });

  it("keeps a cached head whose unpriced models are still unpriced", () => {
    const diff = diffSessionSources([ref("a")], [makeSession("a")], {
      a: meta("a", { unpricedModels: ["vendor/nonexistent-model"] }),
    });

    expect(diff.changedIds).toEqual([]);
  });

  it("re-parses a cached head from before pricing misses were captured", () => {
    const diff = diffSessionSources([ref("a")], [makeSession("a")], {
      a: meta("a", { pricingCaptureEpoch: undefined }),
    });

    expect(diff.changedIds).toEqual(["a"]);
  });

  it("treats a ref with no cached session as changed even when its meta matches", () => {
    const diff = diffSessionSources([ref("a")], [], { a: meta("a") });
    expect(diff).toEqual({
      changedIds: ["a"],
      removedIds: [],
      failedIds: [],
      sourceOutcomes: [],
    });
  });

  it("separates removed sessions from changed ones", () => {
    const diff = diffSessionSources([ref("a")], [makeSession("a"), makeSession("gone")], {
      a: meta("a"),
      gone: meta("gone"),
    });

    expect(diff).toEqual({
      changedIds: [],
      removedIds: ["gone"],
      failedIds: [],
      sourceOutcomes: [
        {
          status: "missing",
          source: ref("gone"),
        },
      ],
    });
  });

  it("removes a cached session whose meta records no source path", () => {
    const diff = diffSessionSources([], [makeSession("orphan")], {});

    expect(diff).toEqual({
      changedIds: [],
      removedIds: ["orphan"],
      failedIds: [],
      sourceOutcomes: [
        {
          status: "missing",
          source: { sessionId: "orphan", sourcePath: "", fingerprint: "" },
        },
      ],
    });
  });

  it("treats an existing cached path omitted by enumeration as failed, not removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "codesesh-source-outcome-"));
    const sourcePath = join(directory, "half-written.jsonl");
    writeFileSync(sourcePath, "{");
    try {
      const diff = diffSessionSources([], [makeSession("cached")], {
        cached: meta("cached", { sourcePath }),
      });

      expect(diff).toMatchObject({
        changedIds: [],
        removedIds: [],
        failedIds: ["cached"],
        sourceOutcomes: [
          {
            status: "failed",
            failure: {
              sessionId: "cached",
              sourcePath,
              stage: "enumeration",
              errorClass: "Error",
            },
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a cached path stat error as failed, not missing", () => {
    const sourcePath = "invalid\0path";
    const diff = diffSessionSources([], [makeSession("cached")], {
      cached: meta("cached", { sourcePath }),
    });

    expect(diff.removedIds).toEqual([]);
    expect(diff.failedIds).toEqual(["cached"]);
    expect(diff.sourceOutcomes[0]).toMatchObject({
      status: "failed",
      failure: { errorClass: "ERR_INVALID_ARG_VALUE" },
    });
  });

  it("keeps sessions whose mtime falls outside the scan window", () => {
    const cached = [makeSession("recent"), makeSession("old"), makeSession("undated")];
    const entries = {
      recent: meta("recent", { sourceMtimeMs: 500 }),
      old: meta("old", { sourceMtimeMs: 10 }),
      undated: meta("undated"),
    };

    const windowed = diffSessionSources([], cached, entries, { from: 100 });
    const unwindowed = diffSessionSources([], cached, entries);

    // `old` was never enumerated this pass, so its absence proves nothing.
    // `undated` records no mtime, so we cannot tell either — removing it would
    // destroy a cached session on a guess, keeping it costs one stale entry.
    expect(windowed.removedIds).toEqual(["recent"]);
    // With no window every session was enumerated, so absence does mean deleted.
    expect(unwindowed.removedIds).toEqual(["recent", "old", "undated"]);
  });
});

describe("FileSystemSessionSource source inspection", () => {
  it("reports no changes when fingerprints and paths match", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    // Seed metaMap as if a prior scan populated it.
    agent.scanSessionSourceOutcome({
      sessionId: "a",
      sourcePath: "/tmp/a.jsonl",
      fingerprint: "fp-1",
    });
    agent.scanSessionSourceOutcome({
      sessionId: "b",
      sourcePath: "/tmp/b.jsonl",
      fingerprint: "fp-1",
    });

    const result = synchronizeFileSource(agent, [makeSession("a"), makeSession("b")], {
      kind: "inspect",
    });
    expect(result.detectedSessionIds).toEqual([]);
  });

  it("detects added sources", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    agent.scanSessionSourceOutcome({
      sessionId: "a",
      sourcePath: "/tmp/a.jsonl",
      fingerprint: "fp-1",
    });

    const result = synchronizeFileSource(agent, [makeSession("a")], { kind: "inspect" });
    expect(result.detectedSessionIds).toEqual(["b"]);
  });

  it("detects removed sources", () => {
    const agent = new FakeFileSystemSource([source("a")]);
    agent.scanSessionSourceOutcome({
      sessionId: "a",
      sourcePath: "/tmp/a.jsonl",
      fingerprint: "fp-1",
    });
    agent.restoreSessionCacheMeta({
      ...agent.snapshotSessionCacheMeta(),
      ghost: { id: "ghost", sourcePath: "/tmp/ghost-does-not-exist.jsonl" },
    });

    const result = synchronizeFileSource(agent, [makeSession("a"), makeSession("ghost")], {
      kind: "inspect",
    });
    expect(result.detectedSessionIds).toEqual(["ghost"]);
  });

  it("detects changed fingerprints", () => {
    const agent = new FakeFileSystemSource([source("a", "fp-2")]);
    // Cached meta still carries the old fingerprint.
    agent.restoreSessionCacheMeta({
      a: { id: "a", sourcePath: "/tmp/a.jsonl", sourceFingerprint: "fp-1" },
    });

    const result = synchronizeFileSource(agent, [makeSession("a")], { kind: "inspect" });
    expect(result.detectedSessionIds).toEqual(["a"]);
  });

  it("detects changed source paths even with identical fingerprints", () => {
    const agent = new FakeFileSystemSource([source("a", "fp-1")]);
    agent.restoreSessionCacheMeta({
      a: { id: "a", sourcePath: "/tmp/old-a.jsonl", sourceFingerprint: "fp-1" },
    });

    const result = synchronizeFileSource(agent, [makeSession("a")], { kind: "inspect" });
    expect(result.detectedSessionIds).toEqual(["a"]);
  });

  it("treats missing fingerprint as changed", () => {
    const agent = new FakeFileSystemSource([source("a")]);
    agent.restoreSessionCacheMeta({ a: { id: "a", sourcePath: "/tmp/a.jsonl" } });

    const result = synchronizeFileSource(agent, [makeSession("a")], { kind: "inspect" });
    expect(result.detectedSessionIds).toEqual(["a"]);
  });

  it("returns refs matching the listSessionSources enumeration", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    agent.scanSessionSource("/tmp/a.jsonl");
    agent.scanSessionSource("/tmp/b.jsonl");

    const result = synchronizeFileSource(agent, [makeSession("a"), makeSession("b")], {
      kind: "inspect",
    });
    expect(result.sources).toEqual(agent.listSessionSources());
  });
});

describe("FileSystemSessionSource source synchronization", () => {
  it("reports source enumeration, change, and processing workload", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);

    const result = agent.synchronizeSessionSources({ sessions: [], meta: {} }, { kind: "reload" });

    expect(result.timing).toMatchObject({
      totalMs: expect.any(Number),
      enumerationMs: expect.any(Number),
      diffMs: expect.any(Number),
      parseMs: expect.any(Number),
      enumeratedSourceCount: 2,
      changedSourceCount: 2,
      processedSourceCount: 2,
    });
  });

  it("re-parses changed sources and merges into cached sessions", () => {
    const agent = new FakeFileSystemSource([
      source("a", "fp-1", { head: makeSession("a") }),
      source("b", "fp-1", { head: makeSession("b") }),
    ]);

    const updated = synchronizeFileSource(agent, [makeSession("a"), makeSession("b")], {
      kind: "known-changes",
      changedIds: ["a"],
    }).sessions;
    expect(updated.map((s) => s.reference.sessionId).sort()).toEqual(["a", "b"]);
    expect(agent.getSessionCacheMeta("a")?.sourceFingerprint).toBe("fp-1");
  });

  it("adds new sources when listed but missing from cache", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b")]);
    const updated = synchronizeFileSource(agent, [makeSession("a")], {
      kind: "known-changes",
      changedIds: ["b"],
    }).sessions;
    expect(updated.map((s) => s.reference.sessionId).sort()).toEqual(["a", "b"]);
  });

  it("retains the last-known-good session when a source no longer parses", () => {
    const agent = new FakeFileSystemSource([source("a"), source("b", "fp-1", { head: null })]);
    const updated = synchronizeFileSource(agent, [makeSession("a"), makeSession("b")], {
      kind: "known-changes",
      changedIds: ["b"],
    }).sessions;
    expect(updated.map((s) => s.reference.sessionId)).toEqual(["a", "b"]);
    expect(agent.getSessionCacheMeta("b")).toBeUndefined();
  });

  it.each([
    ["EACCES", Object.assign(new Error("permission denied"), { code: "EACCES" })],
    ["truncated JSON", undefined],
  ])("retains meta after %s and updates after the source recovers", (_label, error) => {
    const before = makeSession("a");
    const agent = new FakeFileSystemSource([source("a", "fp-old", { head: before })]);
    agent.scanSessionSource("/tmp/a.jsonl");
    agent.setSources([source("a", "fp-new", { head: null, error })]);

    const retained = synchronizeFileSource(agent, [before], {
      kind: "known-changes",
      changedIds: ["a"],
    }).sessions;

    expect(retained).toEqual([before]);
    expect(agent.getSessionCacheMeta("a")?.sourceFingerprint).toBe("fp-old");

    const recovered = makeSession("a");
    recovered.title = "recovered";
    agent.setSources([source("a", "fp-new", { head: recovered })]);

    expect(
      synchronizeFileSource(agent, retained, {
        kind: "known-changes",
        changedIds: ["a"],
      }).sessions[0]?.title,
    ).toBe("recovered");
    expect(agent.getSessionCacheMeta("a")?.sourceFingerprint).toBe("fp-new");
  });

  it("removes a cached session only when the adapter explicitly filters it", () => {
    const before = makeSession("a");
    const agent = new FakeFileSystemSource([source("a", "fp-old", { head: before })]);
    agent.scanSessionSource("/tmp/a.jsonl");
    agent.setSources([source("a", "fp-new", { head: null, filtered: true })]);

    const updated = synchronizeFileSource(agent, [before], {
      kind: "known-changes",
      changedIds: ["a"],
    }).sessions;

    expect(updated).toEqual([]);
    expect(agent.getSessionCacheMeta("a")).toBeUndefined();
  });

  it("removes a cached session when its source disappears between enumeration and parsing", () => {
    const before = makeSession("a");
    const agent = new FakeFileSystemSource([source("a", "fp-old", { head: before })]);
    agent.scanSessionSource("/tmp/a.jsonl");
    const missingError = Object.assign(new Error("source disappeared"), { code: "ENOENT" });
    agent.setSources([source("a", "fp-new", { head: null, error: missingError })]);

    const updated = synchronizeFileSource(agent, [before], {
      kind: "known-changes",
      changedIds: ["a"],
    }).sessions;

    expect(updated).toEqual([]);
    expect(agent.getSessionCacheMeta("a")).toBeUndefined();
  });

  it("skips listSessionSources when refs are passed explicitly, matching the fallback result", () => {
    const agent = new FakeFileSystemSource([
      source("a", "fp-1", { head: makeSession("a") }),
      source("b", "fp-1", { head: null }),
    ]);
    const cached = [makeSession("a"), makeSession("b")];
    const changedIds = ["a", "b"];
    const refs = agent.listSessionSources();

    const fallback = synchronizeFileSource(agent, cached, {
      kind: "known-changes",
      changedIds,
    }).sessions;

    const listSpy = vi.spyOn(agent, "listSessionSources");
    const withRefs = synchronizeFileSource(agent, cached, {
      kind: "known-changes",
      changedIds,
      refs,
    }).sessions;

    expect(listSpy).toHaveBeenCalledTimes(0);
    expect(withRefs.map((s) => s.reference.sessionId).sort()).toEqual(
      fallback.map((s) => s.reference.sessionId).sort(),
    );
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
    lastScanOptions: AgentScanOptions | undefined;

    constructor(private dbPath: string | null) {
      super();
    }

    isAvailable(): boolean {
      return true;
    }

    getSessionWatchPlan() {
      return { status: "not-needed" as const, reason: "temporary test database" };
    }

    scan(options?: AgentScanOptions): SessionHead[] {
      this.scanCount += 1;
      this.lastScanOptions = options;
      return [makeSession("db-1")];
    }

    getSessionData(_sessionId: string): SessionDetail {
      return {} as SessionDetail;
    }

    protected getDatabasePath(): string | null {
      return this.dbPath;
    }
  }

  it("reports no changes when db mtime has not advanced", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1")];
    agent.restoreSessionCacheMeta({
      "db-1": { id: "db-1", sourcePath: dbPath, pricingCaptureEpoch: PRICING_CAPTURE_EPOCH },
    });

    // since far in the future → no changes
    const fresh = agent.checkForChanges(Date.now() + 1_000_000, cached);
    expect(fresh.hasChanges).toBe(false);
    expect(fresh).not.toHaveProperty("changedIds");
  });

  it("invalidates database heads cached before pricing capture", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1")];
    agent.restoreSessionCacheMeta({ "db-1": { id: "db-1", sourcePath: dbPath } });

    expect(agent.checkForChanges(Date.now() + 1_000_000, cached).hasChanges).toBe(true);
  });

  it("reports an imprecise change when db mtime is newer than since", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1"), makeSession("db-2")];

    const stale = agent.checkForChanges(0, cached);
    expect(stale.hasChanges).toBe(true);
    expect(stale).not.toHaveProperty("changedIds");
  });

  it("re-detects a database change when the consuming scan never commits", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    const cached = [makeSession("db-1")];
    agent.restoreSessionCacheMeta({
      "db-1": { id: "db-1", sourcePath: dbPath, pricingCaptureEpoch: PRICING_CAPTURE_EPOCH },
    });

    // A successful pass commits its observation as the baseline.
    agent.checkForChanges(Date.now() + 1_000_000, cached);
    agent.commitChangeCheck();

    writeFileSync(dbPath, "changed-once");
    expect(agent.checkForChanges(0, cached).hasChanges).toBe(true);
    // The scan consuming that check failed → no commit → still flagged.
    expect(agent.checkForChanges(0, cached).hasChanges).toBe(true);

    agent.commitChangeCheck();
    // since=0 would read "changed" via the mtime fallback; false proves the
    // committed fingerprint is now the comparison baseline.
    expect(agent.checkForChanges(0, cached).hasChanges).toBe(false);
  });

  it("reports no changes when database path is missing", () => {
    const agent = new FakeDatabaseSource(null);
    const result = agent.checkForChanges(0, [makeSession("db-1")]);
    expect(result.hasChanges).toBe(false);
  });

  it("returns a failure without advancing the database change baseline", () => {
    const dbPath = makeDb();
    const agent = new FakeDatabaseSource(dbPath);
    agent.restoreSessionCacheMeta({
      "db-1": {
        id: "db-1",
        sourcePath: dbPath,
        pricingCaptureEpoch: PRICING_CAPTURE_EPOCH,
        unpricedModels: ["unavailable-model"],
      },
    });
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      warn: (event, detail) => events.push({ event, detail }),
    });
    const resolve = vi.spyOn(pricingResolver, "resolve").mockImplementationOnce(() => {
      throw new Error("pricing registry unavailable");
    });

    const result = agent.checkForChanges(123, [makeSession("db-1")]);

    resolve.mockRestore();
    setCoreDiagnostics(null);
    expect(result).toEqual({
      status: "failed",
      hasChanges: false,
      timestamp: 123,
      failure: {
        sourcePath: dbPath,
        errorClass: "Error",
        message: "pricing registry unavailable",
      },
    });
    expect(events).toEqual([
      {
        event: "agent.change_check_failed",
        detail: {
          agent: "fakedb",
          source_path: dbPath,
          error_class: "Error",
          message: "pricing registry unavailable",
          baseline_advanced: false,
        },
      },
    ]);
  });

  it("incrementalScan delegates to a full scan", () => {
    const agent = new FakeDatabaseSource(makeDb());
    const options = { from: 1_000, to: 2_000 };
    const sessions = agent.incrementalScan([makeSession("stale")], ["stale"], undefined, options);
    expect(agent.scanCount).toBe(1);
    expect(agent.lastScanOptions).toEqual(options);
    expect(sessions.map((s) => s.reference.sessionId)).toEqual(["db-1"]);
  });

  it("rememberSession records meta keyed by db path", () => {
    const agent = new FakeDatabaseSource("/tmp/fake.db") as FakeDatabaseSource & {
      rememberSession(id: string): void;
    };
    agent.rememberSession("db-1");
    const meta: SessionCacheMeta | undefined = agent.getSessionCacheMeta("db-1");
    expect(meta?.sourcePath).toBe("/tmp/fake.db");
    expect(meta?.pricingCaptureEpoch).toBe(PRICING_CAPTURE_EPOCH);
  });

  it("re-scans a database session when captured model pricing arrives", () => {
    const model = "vendor/database-pricing-later";
    let pricingAvailable = false;
    const originalResolve = pricingResolver.resolve.bind(pricingResolver);
    vi.spyOn(pricingResolver, "resolve").mockImplementation((modelName) =>
      modelName === model ? (pricingAvailable ? TEST_PRICING : null) : originalResolve(modelName),
    );

    class PricingDatabaseSource extends FakeDatabaseSource {
      override scan(): SessionHead[] {
        this.scanCount += 1;
        const session = this.captureSessionPricingMisses(() => {
          const cost = estimateTokenCost(model, { input: 100, output: 20 }) ?? 0;
          return {
            ...makeSession("db-1"),
            stats: {
              ...makeSession("db-1").stats,
              total_input_tokens: 100,
              total_output_tokens: 20,
              total_cost: cost,
              cost_source: cost > 0 ? ("estimated" as const) : undefined,
            },
          };
        });
        return [session];
      }
    }

    try {
      const agent = new PricingDatabaseSource(makeDb());
      const cached = agent.scan();
      expect(cached[0]?.stats.total_cost).toBe(0);
      expect(agent.getSessionCacheMeta("db-1")?.unpricedModels).toEqual([model]);
      expect(agent.checkForChanges(Date.now() + 1_000_000, cached).hasChanges).toBe(false);

      pricingAvailable = true;
      expect(agent.checkForChanges(Date.now() + 1_000_000, cached).hasChanges).toBe(true);

      const refreshed = agent.incrementalScan(cached, []);
      expect(refreshed[0]?.stats.total_cost).toBeGreaterThan(0);
      expect(agent.getSessionCacheMeta("db-1")?.unpricedModels).toBeUndefined();
      expect(agent.checkForChanges(Date.now() + 1_000_000, refreshed).hasChanges).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("CS-139: WAL-mode change detection", () => {
  const dbDirs: string[] = [];

  afterEach(() => {
    for (const dir of dbDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  class WalDatabaseSource extends DatabaseSessionSource {
    readonly name = "waldb";
    readonly displayName = "WAL DB";

    constructor(private readonly dbPath: string) {
      super();
    }

    isAvailable(): boolean {
      return true;
    }

    getSessionWatchPlan() {
      return { status: "not-needed" as const, reason: "temporary test database" };
    }

    scan(): SessionHead[] {
      const db = new Database(this.dbPath, { readonly: true });
      try {
        db.prepare("SELECT id FROM session").all();
        return [];
      } finally {
        db.close();
      }
    }

    getSessionData(): SessionDetail {
      return {} as SessionDetail;
    }

    protected getDatabasePath(): string {
      return this.dbPath;
    }
  }

  function createWalDatabase() {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-wal-test-"));
    dbDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO session VALUES (?)").run("s1");
    return { dbPath, db, agent: new WalDatabaseSource(dbPath) };
  }

  it("sees a commit that has not been checkpointed", () => {
    const { db, agent } = createWalDatabase();
    // Establish the baseline the way a running server would: a check whose
    // consuming scan succeeded gets committed by the orchestrator.
    agent.checkForChanges(0, []);
    agent.commitChangeCheck();
    expect(agent.checkForChanges(0, []).hasChanges).toBe(false);

    db.prepare("INSERT INTO session VALUES (?)").run("s2");

    expect(agent.checkForChanges(0, []).hasChanges).toBe(true);
    db.close();
  });

  it("does not report a change caused by its own read-only scan", () => {
    const { db, agent } = createWalDatabase();
    agent.checkForChanges(0, []);
    agent.commitChangeCheck();

    agent.scan();

    expect(agent.checkForChanges(0, []).hasChanges).toBe(false);
    db.close();
  });

  it("sees a checkpoint and the sidecar removal that follows", () => {
    const { db, agent } = createWalDatabase();
    db.prepare("INSERT INTO session VALUES (?)").run("s2");
    agent.checkForChanges(0, []);

    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(agent.checkForChanges(0, []).hasChanges).toBe(true);

    db.close();
    expect(agent.checkForChanges(0, []).hasChanges).toBe(true);
  });

  it("uses the newest sidecar time on the first check after startup", () => {
    const { db, agent } = createWalDatabase();
    const before = Date.now() - 60_000;

    // A WAL written while the process was down leaves the main file untouched.
    expect(agent.checkForChanges(before, []).hasChanges).toBe(true);
    db.close();
  });
});
