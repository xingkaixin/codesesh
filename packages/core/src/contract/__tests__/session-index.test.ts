import { describe, expect, it } from "vitest";
import type { SessionHead } from "../session.js";
import { getProjectAgentKey } from "../project-identity.js";
import {
  applySessionChanges,
  createSessionIndex,
  getSessionRouteKey,
  mergeSortedSessions,
  sortSessionsByActivity,
  updateSessionIndex,
} from "../session-index.js";
import { getSessionAgentKey } from "../session-reference.js";

function createSession(
  id: string,
  activity: number,
  overrides: Partial<SessionHead> = {},
): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/workspace/app",
    time_created: activity,
    time_updated: activity,
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function sessionIds(sessions: SessionHead[] | undefined): string[] {
  return sessions?.map((session) => session.id) ?? [];
}

describe("canonical session index", () => {
  it("preserves stable ordering and the first duplicate route", () => {
    const first = createSession("same", 100, { title: "First" });
    const duplicate = createSession("same", 100, { title: "Duplicate" });
    const next = createSession("next", 100);

    const index = createSessionIndex([first, duplicate, next]);

    expect(index.sessionsByActivity).toEqual([first, duplicate, next]);
    expect(index.byRouteKey.get(getSessionRouteKey("codex", "same"))).toBe(first);
  });

  it("keeps project identity kinds and agents in separate indexes", () => {
    const remote = createSession("remote", 300, {
      project_identity: {
        kind: "git_remote",
        key: "github.com/acme/app",
        displayName: "App",
      },
    });
    const path = createSession("path", 200, {
      slug: "claude/path",
      project_identity: {
        kind: "path",
        key: "github.com/acme/app",
        displayName: "App path",
      },
    });

    const index = createSessionIndex([path, remote]);

    expect(sessionIds(index.byProjectIdentityKey.get("git_remote:github.com/acme/app"))).toEqual([
      "remote",
    ]);
    expect(sessionIds(index.byProjectIdentityKey.get("path:github.com/acme/app"))).toEqual([
      "path",
    ]);
    expect(
      sessionIds(
        index.byProjectAgentKey.get(getProjectAgentKey("git_remote:github.com/acme/app", "codex")),
      ),
    ).toEqual(["remote"]);
  });

  it("keeps child sessions under their parent's full reference", () => {
    const codexChild = createSession("codex-child", 100, {
      parent_reference: { agentName: "codex", sessionId: "shared-parent" },
    });
    const claudeChild = createSession("claude-child", 200, {
      slug: "claude/claude-child",
      parent_reference: { agentName: "claude", sessionId: "shared-parent" },
    });

    const index = createSessionIndex([codexChild, claudeChild]);

    expect(
      index.childrenByParentRouteKey.get(getSessionRouteKey("codex", "shared-parent")),
    ).toEqual([codexChild]);
    expect(
      index.childrenByParentRouteKey.get(getSessionRouteKey("claude", "shared-parent")),
    ).toEqual([claudeChild]);
  });

  it("indexes by the authoritative reference instead of the compatibility slug", () => {
    const malformed = createSession("malformed", 100, { slug: "" });

    const index = createSessionIndex([malformed]);

    expect(index.byAgent.get("codex")).toEqual([malformed]);
    expect(index.byRouteKey.get(getSessionRouteKey("codex", "malformed"))).toBe(malformed);
  });

  it("applies route-keyed changes and removals with wire-event semantics", () => {
    const old = createSession("old", 100);
    const replaced = createSession("same", 200, { title: "Old title" });
    const replacement = createSession("same", 400, { title: "New title" });
    const added = createSession("added", 300, { slug: "claude/added" });

    const sessions = applySessionChanges(
      [old, replaced],
      [
        {
          reference: { agentName: "codex", sessionId: replacement.id },
          session: replacement,
        },
        {
          reference: { agentName: "claude", sessionId: added.id },
          session: added,
        },
      ],
      [{ agentName: "codex", sessionId: "old" }],
    );

    expect(sessions).toEqual([replacement, added]);
  });

  it("matches a full rebuild across deterministic incremental batches", () => {
    let index = createSessionIndex(
      Array.from({ length: 40 }, (_, value) => createSession(`session-${value}`, value)),
    );

    for (let batch = 0; batch < 20; batch += 1) {
      const changedId = `session-${(batch * 7) % 40}`;
      const added = createSession(`added-${batch}`, 1_000 + batch, {
        slug: `${batch % 2 === 0 ? "codex" : "claude"}/added-${batch}`,
      });
      const changes = [
        {
          reference: { agentName: "codex", sessionId: changedId },
          session: createSession(changedId, 500 + batch),
        },
        {
          reference: { agentName: getSessionAgentKey(added), sessionId: added.id },
          session: added,
        },
      ];
      const removals =
        batch % 3 === 0 ? [{ agentName: "codex", sessionId: `session-${batch}` }] : [];
      const expectedSessions = applySessionChanges(index.sourceSessions, changes, removals);

      index = updateSessionIndex(index, changes, removals);
      const rebuilt = createSessionIndex(expectedSessions);

      expect(index.sessionsByActivity).toEqual(rebuilt.sessionsByActivity);
      expect([...index.byRouteKey.entries()]).toEqual([...rebuilt.byRouteKey.entries()]);
      expect([...index.byAgent.entries()]).toEqual([...rebuilt.byAgent.entries()]);
      expect([...index.byProjectIdentityKey.entries()]).toEqual([
        ...rebuilt.byProjectIdentityKey.entries(),
      ]);
    }
  });
});

describe("mergeSortedSessions", () => {
  /** Deterministic PRNG so a failure is reproducible from the printed seed. */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function makeShards(random: () => number, shardCount: number): SessionHead[][] {
    return Array.from({ length: shardCount }, (_unused, shardIndex) => {
      const size = Math.floor(random() * 6);
      const shard = Array.from({ length: size }, (_item, index) =>
        // A small activity range guarantees plenty of cross-shard ties.
        createSession(`s${shardIndex}-${index}`, Math.floor(random() * 4)),
      );
      return sortSessionsByActivity(shard);
    });
  }

  it("returns an empty array when every shard is empty", () => {
    expect(mergeSortedSessions([])).toEqual([]);
    expect(mergeSortedSessions([[], []])).toEqual([]);
  });

  it("copies a lone shard rather than returning it", () => {
    const shard = [createSession("a", 2), createSession("b", 1)];
    const merged = mergeSortedSessions([shard]);

    expect(merged).toEqual(shard);
    expect(merged).not.toBe(shard);
  });

  it("matches sortSessionsByActivity element for element, ties included", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const shards = makeShards(makeRandom(seed), 2 + (seed % 6));
      const merged = mergeSortedSessions(shards);
      const sorted = sortSessionsByActivity(shards.flat());

      // Reference equality, so a tie resolved to a different shard fails here.
      expect({ seed, ids: merged.map((session) => session.id) }).toEqual({
        seed,
        ids: sorted.map((session) => session.id),
      });
      expect(merged.every((session, index) => session === sorted[index])).toBe(true);
    }
  });
});
