import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICING_CAPTURE_EPOCH } from "../../pricing/cost.js";
import type { SessionHead } from "../../types/index.js";
import {
  createSessionSourceFailure,
  synchronizeSessionSources,
  type SessionCacheMeta,
  type SessionSourceOutcome,
  type SessionSourceRef,
  type SessionSourceSynchronizationAdapter,
} from "../base.js";

function session(id: string, title = id): SessionHead {
  return {
    id,
    slug: `test/${id}`,
    title,
    directory: "/workspace",
    time_created: 1,
    time_updated: 2,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function source(sessionId: string, fingerprint = "current"): SessionSourceRef {
  return { sessionId, sourcePath: `/${sessionId}`, fingerprint };
}

function meta(ref: SessionSourceRef, sourceMtimeMs = 2): SessionCacheMeta {
  return {
    id: ref.sessionId,
    sourcePath: ref.sourcePath,
    sourceFingerprint: ref.fingerprint,
    sourceMtimeMs,
    pricingCaptureEpoch: PRICING_CAPTURE_EPOCH,
  };
}

class MemorySourceAdapter implements SessionSourceSynchronizationAdapter {
  readonly name = "memory";
  listCalls = 0;
  scannedIds: string[] = [];
  listError: Error | null = null;
  private meta = new Map<string, SessionCacheMeta>();

  constructor(
    private sources: SessionSourceRef[],
    private outcomes: Map<string, SessionSourceOutcome>,
    private readonly expandedIds: string[] | null = null,
    private readonly visibleIds: Set<string> | null = null,
  ) {}

  setSources(sources: SessionSourceRef[]): void {
    this.sources = sources;
  }

  setOutcomes(outcomes: Map<string, SessionSourceOutcome>): void {
    this.outcomes = outcomes;
  }

  listSessionSources(): SessionSourceRef[] {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return this.sources;
  }

  scanSessionSourceOutcome(sourceRef: SessionSourceRef): SessionSourceOutcome {
    this.scannedIds.push(sourceRef.sessionId);
    const outcome = this.outcomes.get(sourceRef.sessionId);
    if (!outcome) throw new Error(`Missing outcome for ${sourceRef.sessionId}`);
    if (outcome.status === "parsed") this.meta.set(sourceRef.sessionId, meta(sourceRef));
    return outcome;
  }

  expandChangedSessionIds(changedIds: string[]): string[] {
    return this.expandedIds ?? changedIds;
  }

  filterCachedSessions(sessions: SessionHead[]): SessionHead[] {
    return this.visibleIds
      ? sessions.filter((session) => this.visibleIds!.has(session.id))
      : sessions;
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.meta;
  }

  setSessionMetaMap(metaMap: Map<string, SessionCacheMeta>): void {
    this.meta = metaMap;
  }
}

function parsed(ref: SessionSourceRef, head: SessionHead): SessionSourceOutcome {
  return { status: "parsed", source: ref, session: head };
}

describe("synchronizeSessionSources", () => {
  it("refreshes changed sources, expands dependencies, and removes proven absences", () => {
    const unchangedRef = source("unchanged", "same");
    const changedRef = source("changed", "new");
    const parentRef = source("parent", "same");
    const removedPath = join(tmpdir(), "codesesh-session-source-sync-removed");
    const removedRef = { ...source("removed", "old"), sourcePath: removedPath };
    const updated = session("changed", "updated");
    const parent = session("parent", "recomputed");
    const adapter = new MemorySourceAdapter(
      [unchangedRef, changedRef, parentRef],
      new Map([
        ["changed", parsed(changedRef, updated)],
        ["parent", parsed(parentRef, parent)],
      ]),
      ["changed", "removed", "parent"],
    );

    const outcome = synchronizeSessionSources(
      adapter,
      {
        sessions: [
          session("unchanged"),
          session("changed", "old"),
          session("parent", "old parent"),
          session("removed"),
        ],
        meta: {
          unchanged: meta(unchangedRef),
          changed: meta(source("changed", "old")),
          parent: meta(parentRef),
          removed: meta(removedRef),
        },
      },
      { kind: "refresh" },
    );

    expect(adapter.scannedIds).toEqual(["changed", "parent"]);
    expect(adapter.listCalls).toBe(1);
    expect(outcome.sessions.map(({ id }) => id)).toEqual(["unchanged", "changed", "parent"]);
    expect(outcome.sessions.find(({ id }) => id === "changed")?.title).toBe("updated");
    expect(outcome.detectedSessionIds).toEqual(["changed", "removed"]);
    expect(outcome.changedSessionIds).toEqual(["removed", "changed", "parent"]);
    expect(outcome.explicitRemovedSessionIds).toEqual(["removed"]);
    expect(outcome.completeness).toBe("complete");
  });

  it("keeps sources outside a scoped enumeration and marks the outcome partial", () => {
    const recentRef = source("recent", "new");
    const recent = session("recent", "updated");
    const adapter = new MemorySourceAdapter(
      [recentRef],
      new Map([["recent", parsed(recentRef, recent)]]),
    );

    const outcome = synchronizeSessionSources(
      adapter,
      {
        sessions: [session("recent", "old"), session("outside")],
        meta: {
          recent: meta(source("recent", "old"), 200),
          outside: meta(source("outside", "old"), 10),
        },
      },
      { kind: "refresh", scanOptions: { from: 100 } },
    );

    expect(outcome.sessions.map(({ id }) => id)).toEqual(["recent", "outside"]);
    expect(outcome.explicitRemovedSessionIds).toEqual([]);
    expect(outcome.finalizeSessionIds).toEqual(["recent"]);
    expect(outcome.completeness).toBe("partial");
  });

  it("retains last-known-good facts on failure and converges after retry", () => {
    const ref = source("retry", "new");
    const before = session("retry", "before");
    const failure = createSessionSourceFailure(ref, "parsing", new Error("truncated JSON"));
    const adapter = new MemorySourceAdapter(
      [ref],
      new Map([["retry", { status: "failed", failure }]]),
    );
    const baseline = {
      sessions: [before],
      meta: { retry: meta(source("retry", "old")) },
    };

    const failed = synchronizeSessionSources(adapter, baseline, { kind: "refresh" });

    expect(failed.sessions).toEqual([before]);
    expect(failed.meta.retry?.sourceFingerprint).toBe("old");
    expect(failed.sourceFailures).toEqual([failure]);
    expect(failed.completeness).toBe("partial");

    const recovered = session("retry", "recovered");
    adapter.setOutcomes(new Map([["retry", parsed(ref, recovered)]]));
    const retried = synchronizeSessionSources(
      adapter,
      { sessions: failed.sessions, meta: failed.meta },
      { kind: "refresh" },
    );
    const repeated = synchronizeSessionSources(
      adapter,
      { sessions: retried.sessions, meta: retried.meta },
      { kind: "refresh" },
    );

    expect(retried.sessions).toEqual([recovered]);
    expect(retried.completeness).toBe("complete");
    expect(repeated.sessions).toEqual(retried.sessions);
    expect(repeated.changedSessionIds).toEqual([]);
    expect(adapter.scannedIds).toEqual(["retry", "retry"]);
  });

  it("skips a source that fails to parse without any retained baseline session", () => {
    const goodRef = source("good");
    const emptyRef = source("empty");
    const failure = createSessionSourceFailure(emptyRef, "parsing", new Error("empty file"));
    const adapter = new MemorySourceAdapter(
      [goodRef, emptyRef],
      new Map<string, SessionSourceOutcome>([
        ["good", parsed(goodRef, session("good"))],
        ["empty", { status: "failed", failure }],
      ]),
    );

    const outcome = synchronizeSessionSources(
      adapter,
      { sessions: [], meta: {} },
      { kind: "refresh" },
    );

    expect(outcome.sessions.map(({ id }) => id)).toEqual(["good"]);
    expect(outcome.sourceFailures).toEqual([]);
    expect(outcome.completeness).toBe("complete");
    expect(outcome.sourceOutcomes).toContainEqual({ status: "failed", failure });
  });

  it("reloads every enumerated source and removes explicitly filtered sessions", () => {
    const visibleRef = source("visible");
    const filteredRef = source("filtered");
    const adapter = new MemorySourceAdapter(
      [visibleRef, filteredRef],
      new Map([
        ["visible", parsed(visibleRef, session("visible", "reloaded"))],
        ["filtered", { status: "filtered", source: filteredRef, reason: "no visible messages" }],
      ]),
    );

    const outcome = synchronizeSessionSources(
      adapter,
      {
        sessions: [session("visible", "cached"), session("filtered")],
        meta: { visible: meta(visibleRef), filtered: meta(filteredRef) },
      },
      { kind: "reload" },
    );

    expect(adapter.scannedIds).toEqual(["visible", "filtered"]);
    expect(outcome.sessions).toEqual([session("visible", "reloaded")]);
    expect(outcome.explicitRemovedSessionIds).toEqual(["filtered"]);
  });

  it("surfaces cached sessions rejected by the adapter as explicit removals", () => {
    const staleRef = source("stale", "old");
    const adapter = new MemorySourceAdapter([], new Map(), null, new Set());

    const outcome = synchronizeSessionSources(
      adapter,
      {
        sessions: [session("stale")],
        meta: { stale: meta(staleRef) },
      },
      { kind: "refresh" },
    );

    expect(outcome.sessions).toEqual([]);
    expect(outcome.detectedSessionIds).toEqual(["stale"]);
    expect(outcome.changedSessionIds).toEqual(["stale"]);
    expect(outcome.explicitRemovedSessionIds).toEqual(["stale"]);
    expect(outcome.sourceOutcomes).toContainEqual({
      status: "filtered",
      source: staleRef,
      reason: "cached session rejected by adapter",
    });
  });

  it("propagates root enumeration failures without interpreting them as empty data", () => {
    const adapter = new MemorySourceAdapter([], new Map());
    adapter.listError = new Error("root unavailable");

    expect(() =>
      synchronizeSessionSources(
        adapter,
        { sessions: [session("cached")], meta: {} },
        {
          kind: "refresh",
        },
      ),
    ).toThrow("root unavailable");
  });
});
