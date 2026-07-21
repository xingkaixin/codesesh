import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCacheMeta } from "../../agents/base.js";
import { BaseAgent } from "../../agents/base.js";
import type { SessionHead } from "../../types/index.js";
import { clearIdentityCache } from "../../projects/index.js";
import {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  sessionSignature,
  sortSessions,
} from "../orchestrate.js";

// attachMissingProjectIdentities resolves through the process-lifetime
// identity cache (identity.ts); clear it so directories reused across tests
// don't leak cached results between cases.
beforeEach(() => {
  clearIdentityCache();
});

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  const timeCreated = overrides?.time_created ?? 1000;
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: "/home/user/project",
    time_created: timeCreated,
    time_updated: overrides?.time_updated ?? timeCreated,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

describe("attachMissingProjectIdentities", () => {
  it("leaves sessions that already have an identity untouched", () => {
    const existing = { kind: "path" as const, displayName: "proj", key: "/p" };
    const sessions = [makeSession("a", { project_identity: existing })];
    const result = attachMissingProjectIdentities(sessions);
    expect(result[0]!.project_identity).toBe(existing);
  });

  it("computes an identity for sessions missing one", () => {
    const sessions = [makeSession("a", { directory: "/tmp/my-project" })];
    const result = attachMissingProjectIdentities(sessions);
    expect(result[0]!.project_identity).toBeDefined();
    expect(result[0]!.project_identity?.displayName).toBeTruthy();
  });

  it("dedupes identity computation by directory", () => {
    const sessions = [
      makeSession("a", { directory: "/tmp/shared" }),
      makeSession("b", { directory: "/tmp/shared" }),
    ];
    const result = attachMissingProjectIdentities(sessions);
    expect(result[0]!.project_identity).toEqual(result[1]!.project_identity);
  });
});

describe("buildAgentCacheMeta", () => {
  class MetaAgent extends BaseAgent {
    readonly name = "test";
    readonly displayName = "test";
    isAvailable() {
      return true;
    }
    scan() {
      return [];
    }
    getSessionData() {
      return {} as never;
    }
    checkForChanges() {
      return { hasChanges: false, changedIds: [], timestamp: 0 };
    }
    incrementalScan(cached: SessionHead[]) {
      return cached;
    }
    getSessionMetaMap() {
      return new Map<string, SessionCacheMeta>([
        ["a", { id: "a", sourcePath: "/a" }],
        ["b", { id: "b", sourcePath: "/b" }],
      ]);
    }
    setSessionMetaMap() {}
  }

  it("serializes the full meta map", () => {
    const meta = buildAgentCacheMeta(new MetaAgent());
    expect(Object.keys(meta).sort()).toEqual(["a", "b"]);
    expect(meta.a).toMatchObject({ id: "a", sourcePath: "/a" });
  });

  it("filters to the requested session ids", () => {
    const meta = buildAgentCacheMeta(new MetaAgent(), new Set(["a"]));
    expect(Object.keys(meta)).toEqual(["a"]);
  });
});

describe("sessionSignature", () => {
  it("is stable for identical sessions", () => {
    const session = makeSession("a");
    expect(sessionSignature(session)).toBe(sessionSignature(session));
  });

  it("changes when smart_tags_source_updated_at changes", () => {
    const base = makeSession("a");
    const retagged = { ...base, smart_tags_source_updated_at: 9999 };
    expect(sessionSignature(base)).not.toBe(sessionSignature(retagged));
  });

  it("changes when a stat field changes", () => {
    const base = makeSession("a");
    const grown = {
      ...base,
      stats: { ...base.stats, message_count: 42 },
    };
    expect(sessionSignature(base)).not.toBe(sessionSignature(grown));
  });
});

describe("sortSessions", () => {
  it("sorts newest first by time_updated", () => {
    const sessions = [
      makeSession("old", { time_updated: 1000 }),
      makeSession("new", { time_updated: 5000 }),
      makeSession("mid", { time_updated: 3000 }),
    ];
    const sorted = sortSessions(sessions);
    expect(sorted.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("falls back to time_created when time_updated is missing", () => {
    const sessions = [
      makeSession("a", { time_created: 2000, time_updated: undefined }),
      makeSession("b", { time_created: 1000, time_updated: undefined }),
    ];
    const sorted = sortSessions(sessions);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const sessions = [makeSession("a", { time_updated: 1 }), makeSession("b", { time_updated: 2 })];
    const original = [...sessions];
    sortSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(original.map((s) => s.id));
  });
});

describe("computeSessionDiff", () => {
  it("reports no changes when updated equals cached", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const diff = computeSessionDiff(sessions, sessions);
    expect(diff.changes).toEqual([]);
    expect(diff.removedSessionIds).toEqual([]);
    expect(diff.counts).toEqual({ new: 0, updated: 0, removed: 0 });
  });

  it("detects new sessions", () => {
    const cached = [makeSession("a")];
    const updated = [makeSession("a"), makeSession("b")];
    const diff = computeSessionDiff(cached, updated);
    expect(diff.counts).toEqual({ new: 1, updated: 0, removed: 0 });
    expect(diff.changes.map((c) => c.session.id)).toEqual(["b"]);
    expect(diff.changes[0]!.sortIndex).toBe(1);
  });

  it("detects removed sessions", () => {
    const cached = [makeSession("a"), makeSession("b")];
    const updated = [makeSession("a")];
    const diff = computeSessionDiff(cached, updated);
    expect(diff.counts.removed).toBe(1);
    expect(diff.removedSessionIds).toEqual(["b"]);
  });

  it("detects signature changes", () => {
    const cached = [makeSession("a", { title: "old" })];
    const updated = [makeSession("a", { title: "new" })];
    const diff = computeSessionDiff(cached, updated);
    expect(diff.counts).toEqual({ new: 0, updated: 1, removed: 0 });
  });

  it("treats ids in changedIds as updated regardless of signature", () => {
    const cached = [makeSession("a")];
    const updated = [makeSession("a")];
    const diff = computeSessionDiff(cached, updated, ["a"]);
    expect(diff.counts.updated).toBe(1);
    expect(diff.changes.map((c) => c.session.id)).toEqual(["a"]);
  });

  it("accepts a custom signature function", () => {
    const cached = [makeSession("a", { slug: "old" })];
    const updated = [makeSession("a", { slug: "new" })];
    // Default signature ignores slug, so no change detected.
    expect(computeSessionDiff(cached, updated).counts.updated).toBe(0);
    // Custom signature that includes slug detects the change.
    expect(computeSessionDiff(cached, updated, [], (s) => s.slug).counts.updated).toBe(1);
  });

  describe("signatureCache", () => {
    it("skips recomputing the cached-side signature on a warm cache", () => {
      const session = makeSession("a");
      const signatureCache = new Map<string, string>();
      const signature = vi.fn((s: SessionHead) => sessionSignature(s));

      computeSessionDiff([session], [session], [], signature, signatureCache);
      expect(signature).toHaveBeenCalledTimes(2); // cached-side miss + updated-side

      signature.mockClear();
      computeSessionDiff([session], [session], [], signature, signatureCache);
      expect(signature).toHaveBeenCalledTimes(1); // cached-side hit, only updated-side computed
    });

    it("backfills the cache with the updated session's signature", () => {
      const cachedVersion = makeSession("a", { title: "old" });
      const updatedVersion = makeSession("a", { title: "new" });
      const signatureCache = new Map<string, string>();

      computeSessionDiff([cachedVersion], [updatedVersion], [], sessionSignature, signatureCache);

      expect(signatureCache.get("a")).toBe(sessionSignature(updatedVersion));
    });

    it("backfills new sessions too", () => {
      const signatureCache = new Map<string, string>();
      const session = makeSession("a");

      computeSessionDiff([], [session], [], sessionSignature, signatureCache);

      expect(signatureCache.get("a")).toBe(sessionSignature(session));
    });

    it("still detects a real change even when the cache holds a stale entry", () => {
      const signatureCache = new Map<string, string>([["a", "stale-signature"]]);
      const cached = [makeSession("a", { title: "old" })];
      const updated = [makeSession("a", { title: "new" })];

      const diff = computeSessionDiff(cached, updated, [], sessionSignature, signatureCache);

      expect(diff.counts.updated).toBe(1);
    });
  });
});
