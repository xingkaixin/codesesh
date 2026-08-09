import { describe, expect, it, vi } from "vitest";
import type { BookmarkRecord, ReferencedSessionHead, SessionHead } from "../contract/index.js";
import { materializeBookmarkViews } from "./materialize.js";

function makeBookmark(sessionId: string, agentName = "codex", bookmarkedAt = 1): BookmarkRecord {
  return { reference: { agentName, sessionId }, bookmarkedAt };
}

function makeSession(sessionId: string, agentName = "codex", timeUpdated = 1): SessionHead {
  return {
    id: sessionId,
    slug: `${agentName}/${sessionId}`,
    title: `${sessionId} title`,
    directory: "/workspace",
    time_created: 1,
    time_updated: timeUpdated,
    stats: {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0,
    },
  };
}

describe("materializeBookmarkViews", () => {
  it("projects live session heads from bookmark facts", () => {
    const session = { ...makeSession("s1", "codex", 20), title: "Current title" };

    const views = materializeBookmarkViews([makeBookmark("s1", " CoDeX ", 5)], {
      liveSessionsByReference: new Map([["codex/s1", session]]),
      knownAgentNames: new Set(["codex"]),
    });

    expect(views).toEqual([
      {
        reference: { agentName: "codex", sessionId: "s1" },
        bookmarkedAt: 5,
        availability: "available",
        session,
      },
    ]);
  });

  it("resolves sessions outside the live window in one targeted cache batch", () => {
    const cached: ReferencedSessionHead = {
      reference: { agentName: "codex", sessionId: "old" },
      session: { ...makeSession("wrong", "stale", 8), title: "Cached title" },
    };
    const resolveCachedSessions = vi.fn(() => [cached]);

    const views = materializeBookmarkViews(
      [makeBookmark("old"), makeBookmark("missing", "codex", 2)],
      {
        liveSessionsByReference: new Map(),
        knownAgentNames: new Set(["codex"]),
        resolveCachedSessions,
      },
    );

    expect(resolveCachedSessions).toHaveBeenCalledOnce();
    expect(resolveCachedSessions).toHaveBeenCalledWith([
      { agentName: "codex", sessionId: "old" },
      { agentName: "codex", sessionId: "missing" },
    ]);
    expect(views[0]).toMatchObject({
      availability: "available",
      reference: { agentName: "codex", sessionId: "old" },
      session: { id: "old", slug: "codex/old", title: "Cached title" },
    });
  });

  it("distinguishes unavailable sessions from unavailable agents", () => {
    const views = materializeBookmarkViews(
      [makeBookmark("gone", "codex", 3), makeBookmark("gone", "removed-agent", 2)],
      {
        liveSessionsByReference: new Map(),
        knownAgentNames: new Set(["codex"]),
      },
    );

    expect(views).toEqual([
      {
        ...makeBookmark("gone", "codex", 3),
        availability: "session-unavailable",
      },
      {
        ...makeBookmark("gone", "removed-agent", 2),
        availability: "agent-unavailable",
      },
    ]);
  });

  it("looks up only bookmark identities regardless of live collection size", () => {
    const live = new Map(
      Array.from({ length: 10_000 }, (_, index) => {
        const session = makeSession(`unrelated-${index}`);
        return [session.slug, session] as const;
      }),
    );
    live.set("codex/first", makeSession("first"));
    live.set("codex/second", makeSession("second"));
    const get = vi.spyOn(live, "get");

    materializeBookmarkViews([makeBookmark("first"), makeBookmark("second")], {
      liveSessionsByReference: live,
      knownAgentNames: new Set(["codex"]),
    });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("orders available views by activity and unavailable views by bookmarkedAt", () => {
    const live = new Map([
      ["codex/older", makeSession("older", "codex", 10)],
      ["codex/newer", makeSession("newer", "codex", 20)],
    ]);

    const views = materializeBookmarkViews(
      [
        makeBookmark("missing-old", "codex", 2),
        makeBookmark("older", "codex", 100),
        makeBookmark("missing-new", "codex", 4),
        makeBookmark("newer", "codex", 1),
      ],
      { liveSessionsByReference: live, knownAgentNames: new Set(["codex"]) },
    );

    expect(views.map(({ reference }) => reference.sessionId)).toEqual([
      "newer",
      "older",
      "missing-new",
      "missing-old",
    ]);
  });
});
