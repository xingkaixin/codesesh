import { describe, expect, it } from "vitest";
import type { SessionHead } from "../session.js";
import {
  applySessionChanges,
  createSessionIndex,
  getProjectAgentKey,
  getSessionRouteKey,
  updateSessionIndex,
} from "../session-index.js";

function createSession(
  id: string,
  activity: number,
  overrides: Partial<SessionHead> = {},
): SessionHead {
  return {
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

  it("applies route-keyed changes and removals with wire-event semantics", () => {
    const old = createSession("old", 100);
    const replaced = createSession("same", 200, { title: "Old title" });
    const replacement = createSession("same", 400, { title: "New title" });
    const added = createSession("added", 300, { slug: "claude/added" });

    const sessions = applySessionChanges(
      [old, replaced],
      [
        { agentName: "codex", session: replacement },
        { agentName: "claude", session: added },
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
        { agentName: "codex", session: createSession(changedId, 500 + batch) },
        { agentName: added.slug.split("/")[0]!, session: added },
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
