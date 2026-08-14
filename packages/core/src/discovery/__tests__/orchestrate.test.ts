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

function expectSessionChange(update: (session: SessionHead) => SessionHead): void {
  const cached = makeSession("a");
  const updated = update(cached);
  expect(sessionSignature(cached)).not.toBe(sessionSignature(updated));
  expect(computeSessionDiff([cached], [updated]).counts).toEqual({
    new: 0,
    updated: 1,
    removed: 0,
  });
}

describe("attachMissingProjectIdentities", () => {
  it("leaves a session untouched when its identity provenance is current", () => {
    const existing = { kind: "path" as const, displayName: "proj", key: "/p" };
    const projection = {
      identity: existing,
      resolverRevision: "resolver-v1",
      inputSignature: "input-v1",
    };
    const session = makeSession("a", {
      project_identity: existing,
      project_identity_resolver_revision: projection.resolverRevision,
      project_identity_input_signature: projection.inputSignature,
    });
    const result = attachMissingProjectIdentities([session], () => projection);
    expect(result[0]).toBe(session);
  });

  it("computes an identity for sessions missing one", () => {
    const sessions = [makeSession("a", { directory: "/tmp/my-project" })];
    const result = attachMissingProjectIdentities(sessions);
    expect(result[0]!.project_identity).toBeDefined();
    expect(result[0]!.project_identity?.displayName).toBeTruthy();
    expect(result[0]!.project_identity_resolver_revision).toBeTruthy();
    expect(result[0]!.project_identity_input_signature).toBeTruthy();
  });

  it("dedupes identity resolution by normalized directory", () => {
    const sessions = [
      makeSession("a", { directory: "/workspace/shared" }),
      makeSession("b", { directory: "/workspace/shared/." }),
    ];
    const resolve = vi.fn(() => ({
      identity: { kind: "path" as const, key: "/workspace/shared", displayName: "shared" },
      resolverRevision: "resolver-v1",
      inputSignature: "input-v1",
    }));
    const result = attachMissingProjectIdentities(sessions, resolve);
    expect(result[0]!.project_identity).toEqual(result[1]!.project_identity);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("refreshes all sessions when a directory's identity input changes", () => {
    const oldIdentity = { kind: "git_remote" as const, key: "github.com/acme/a", displayName: "a" };
    const sessions = ["a", "b"].map((id) =>
      makeSession(id, {
        project_identity: oldIdentity,
        project_identity_resolver_revision: "resolver-v1",
        project_identity_input_signature: "remote-a",
      }),
    );
    const resolve = vi.fn(() => ({
      identity: { kind: "git_remote" as const, key: "github.com/acme/b", displayName: "b" },
      resolverRevision: "resolver-v1",
      inputSignature: "remote-b",
    }));

    const result = attachMissingProjectIdentities(sessions, resolve);

    expect(result.map((session) => session.project_identity?.key)).toEqual([
      "github.com/acme/b",
      "github.com/acme/b",
    ]);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("revalidates legacy and older-revision identities", () => {
    const identity = { kind: "path" as const, key: "/workspace/app", displayName: "app" };
    const projection = {
      identity,
      resolverRevision: "resolver-v2",
      inputSignature: "same-input",
    };
    const legacy = makeSession("legacy", { project_identity: identity });
    const oldRevision = makeSession("old", {
      project_identity: identity,
      project_identity_resolver_revision: "resolver-v1",
      project_identity_input_signature: "same-input",
    });

    const result = attachMissingProjectIdentities([legacy, oldRevision], () => projection);

    expect(
      result.every((session) => session.project_identity_resolver_revision === "resolver-v2"),
    ).toBe(true);
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
    getSessionWatchPlan() {
      return { status: "not-needed" as const, reason: "orchestration test adapter" };
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

  it("changes when the project identity changes", () => {
    const base = makeSession("a", {
      project_identity: { kind: "path", key: "/old", displayName: "old" },
    });
    const resolved = {
      ...base,
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/acme/new",
        displayName: "new",
      },
    };
    expect(sessionSignature(base)).not.toBe(sessionSignature(resolved));
  });

  it("changes when project identity provenance changes", () => {
    const identity = { kind: "path" as const, key: "/app", displayName: "app" };
    const base = makeSession("a", {
      project_identity: identity,
      project_identity_resolver_revision: "resolver-v1",
      project_identity_input_signature: "input-v1",
    });
    const revised = { ...base, project_identity_resolver_revision: "resolver-v2" };
    const changedInput = { ...base, project_identity_input_signature: "input-v2" };

    expect(sessionSignature(base)).not.toBe(sessionSignature(revised));
    expect(sessionSignature(base)).not.toBe(sessionSignature(changedInput));
  });

  it("changes when smart tags change without a source timestamp change", () => {
    const base = makeSession("a", {
      smart_tags: ["bugfix"],
      smart_tags_source_updated_at: 9999,
    });
    const retagged = { ...base, smart_tags: ["feature-dev" as const] };
    expect(sessionSignature(base)).not.toBe(sessionSignature(retagged));
  });

  it("changes when the smart tag classifier revision changes", () => {
    const base = makeSession("a", {
      smart_tags: ["bugfix"],
      smart_tags_source_updated_at: 9999,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const revised = { ...base, smart_tags_classifier_revision: "smart-tags-v2" };
    expect(sessionSignature(base)).not.toBe(sessionSignature(revised));
  });

  it("ignores smart tag ordering", () => {
    const base = makeSession("a", { smart_tags: ["bugfix", "feature-dev"] });
    const reordered = { ...base, smart_tags: ["feature-dev" as const, "bugfix" as const] };
    expect(sessionSignature(base)).toBe(sessionSignature(reordered));
  });

  it("changes when a stat field changes", () => {
    const base = makeSession("a");
    const grown = {
      ...base,
      stats: { ...base.stats, message_count: 42 },
    };
    expect(sessionSignature(base)).not.toBe(sessionSignature(grown));
  });

  it("changes when the slug changes", () => {
    expectSessionChange((session) => ({ ...session, slug: "agent/changed" }));
  });

  it("changes when model usage changes", () => {
    expectSessionChange((session) => ({
      ...session,
      model_usage: { "test-model": 1 },
    }));
  });

  it("changes when cache read tokens change", () => {
    expectSessionChange((session) => ({
      ...session,
      stats: { ...session.stats, total_cache_read_tokens: 1 },
    }));
  });

  it("changes when cache create tokens change", () => {
    expectSessionChange((session) => ({
      ...session,
      stats: { ...session.stats, total_cache_create_tokens: 1 },
    }));
  });

  it("changes when the cost source changes", () => {
    expectSessionChange((session) => ({
      ...session,
      stats: { ...session.stats, cost_source: "recorded" },
    }));
  });

  it("normalizes optional token counts to zero", () => {
    const base = makeSession("a");
    const explicitZeros = {
      ...base,
      stats: {
        ...base.stats,
        total_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_create_tokens: 0,
      },
    };
    expect(sessionSignature(base)).toBe(sessionSignature(explicitZeros));
    expect(computeSessionDiff([base], [explicitZeros]).counts.updated).toBe(0);
  });

  it("ignores model usage insertion order", () => {
    const base = makeSession("a", { model_usage: { alpha: 1, beta: 2 } });
    const reordered = { ...base, model_usage: { beta: 2, alpha: 1 } };
    expect(sessionSignature(base)).toBe(sessionSignature(reordered));
    expect(computeSessionDiff([base], [reordered]).counts.updated).toBe(0);
  });

  it("ignores alias display titles", () => {
    const base = makeSession("a");
    const aliased = { ...base, display_title: "Aliased session" };
    expect(sessionSignature(base)).toBe(sessionSignature(aliased));
    expect(computeSessionDiff([base], [aliased]).counts.updated).toBe(0);
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
    const cached = [makeSession("a", { title: "old" })];
    const updated = [makeSession("a", { title: "new" })];
    expect(computeSessionDiff(cached, updated).counts.updated).toBe(1);
    expect(computeSessionDiff(cached, updated, [], (session) => session.slug).counts.updated).toBe(
      0,
    );
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
