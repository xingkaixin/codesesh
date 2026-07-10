/**
 * Module-level outcome tests for executeSessionSearch, transplanted from
 * packages/cli/src/api/__tests__/search-characterization.test.ts (which pins
 * the same behavior at the HTTP route). Assertions here are equivalent to
 * that file's route-level assertions for the same fixtures and options --
 * only the entry point differs (direct module call vs. HTTP request). Nothing
 * here is a spec: where behavior looks like a bug or accidental drift, the
 * test still asserts the current output and calls out the quirk in a
 * comment. Do not "fix" these assertions without updating the underlying
 * implementation first.
 *
 * projectKind/projectKey pairing validation (400 on a lone qualifier) is a
 * transport-layer concern and is not exercised here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Message, ProjectIdentity, SessionHead, SmartTag } from "../../types/index.js";
import type { SearchOptions } from "../../discovery/cache/search.js";
import { searchSessions, syncSessionSearchIndex } from "../../discovery/cache.js";
import { executeSessionSearch, type SessionSearchSnapshot } from "../session-search.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-session-search-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

const now = Date.now();

const PROJ_APP: ProjectIdentity = {
  kind: "git_remote",
  key: "github.com/acme/app",
  displayName: "app",
};
const PROJ_OTHER: ProjectIdentity = {
  kind: "git_remote",
  key: "github.com/acme/other",
  displayName: "other",
};

interface FixtureSpec {
  id: string;
  agent: string;
  title?: string;
  cost?: number;
  tags?: SmartTag[];
  project?: ProjectIdentity;
  timeUpdated?: number;
  messages: Message[];
}

function userMessage(id: string, text: string): Message {
  return { id, role: "user", time_created: now, parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): Message {
  return { id, role: "assistant", time_created: now, parts: [{ type: "text", text }] };
}

function toolOutputMessage(id: string, tool: string, output: string): Message {
  return {
    id,
    role: "assistant",
    mode: "tool",
    time_created: now,
    parts: [{ type: "tool", tool, state: { status: "completed", output } }],
  };
}

function fileToolMessage(
  id: string,
  tool: "read" | "edit" | "write" | "delete",
  path: string,
): Message {
  return {
    id,
    role: "assistant",
    mode: "tool",
    time_created: now,
    parts: [{ type: "tool", tool, state: { status: "completed", input: { file_path: path } } }],
  };
}

function makeSessionHead(spec: FixtureSpec): SessionHead {
  const timeUpdated = spec.timeUpdated ?? now;
  return {
    id: spec.id,
    slug: `${spec.agent}/${spec.id}`,
    title: spec.title ?? "plain",
    directory: spec.project ? `/projects/${spec.project.key}` : `/fixtures/${spec.id}`,
    project_identity: spec.project,
    time_created: timeUpdated,
    time_updated: timeUpdated,
    smart_tags: spec.tags,
    stats: {
      message_count: spec.messages.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: spec.cost ?? 0,
    },
  };
}

function makeSessionData(spec: FixtureSpec) {
  return { ...makeSessionHead(spec), messages: spec.messages };
}

// --- fixture sessions -------------------------------------------------
// All `timeUpdated` values below are deliberately distinct (and, except for
// recentOld, within a few seconds of `now`) so activity-time ordering across
// the whole fixture set is unambiguous -- ties would make the "orders by
// activity time descending" characterization non-deterministic.

const recentNew: FixtureSpec = {
  id: "recent-new",
  agent: "claudecode",
  cost: 0.2,
  tags: ["feature-dev"],
  project: PROJ_APP,
  timeUpdated: now,
  messages: [userMessage("recent-new-m1", "needle in the newest session")],
};

// Present in the snapshot but deliberately never synced into the SQLite
// index, simulating the live index lagging behind the in-memory scan.
const laggingSession: FixtureSpec = {
  id: "lagging-session",
  agent: "claudecode",
  cost: 1.2,
  tags: ["bugfix"],
  project: PROJ_OTHER,
  timeUpdated: now - 1_000,
  messages: [userMessage("lagging-session-m1", "needle not yet indexed")],
};

const codexSession: FixtureSpec = {
  id: "codex-session",
  agent: "codex",
  cost: 0.05,
  tags: ["testing"],
  project: PROJ_APP,
  timeUpdated: now - 2_000,
  messages: [userMessage("codex-session-m1", "needle in a codex session")],
};

const recentMid: FixtureSpec = {
  id: "recent-mid",
  agent: "claudecode",
  cost: 3.5,
  tags: ["bugfix"],
  project: PROJ_OTHER,
  timeUpdated: now - 5_000,
  messages: [userMessage("recent-mid-m1", "needle in a bugfix session")],
};

const ftsTitle: FixtureSpec = {
  id: "fts-title",
  agent: "claudecode",
  title: "uniquetitleneedle report",
  timeUpdated: now - 6_000,
  messages: [assistantMessage("fts-title-m1", "body text with no needle token")],
};

const ftsUser: FixtureSpec = {
  id: "fts-user",
  agent: "claudecode",
  timeUpdated: now - 7_000,
  messages: [userMessage("fts-user-m1", "uniqueusermessageneedle detail")],
};

const ftsAssistant: FixtureSpec = {
  id: "fts-assistant",
  agent: "claudecode",
  timeUpdated: now - 8_000,
  messages: [assistantMessage("fts-assistant-m1", "uniqueassistantneedle summary")],
};

const ftsTool: FixtureSpec = {
  id: "fts-tool",
  agent: "claudecode",
  timeUpdated: now - 9_000,
  messages: [toolOutputMessage("fts-tool-m1", "bash", "uniquetoolneedle output")],
};

const orSessionA: FixtureSpec = {
  id: "or-session-a",
  agent: "claudecode",
  timeUpdated: now - 10_000,
  messages: [assistantMessage("or-session-a-m1", "alphaonlyneedle detail")],
};

const orSessionB: FixtureSpec = {
  id: "or-session-b",
  agent: "claudecode",
  timeUpdated: now - 10_100,
  messages: [assistantMessage("or-session-b-m1", "betaonlyneedle detail")],
};

const fileOnly: FixtureSpec = {
  id: "file-only",
  agent: "claudecode",
  timeUpdated: now - 11_000,
  messages: [fileToolMessage("file-only-m1", "edit", "src/app.tsx")],
};

const fileAndText: FixtureSpec = {
  id: "file-and-text",
  agent: "claudecode",
  timeUpdated: now - 12_000,
  messages: [
    fileToolMessage("file-and-text-m1", "edit", "src/shared.ts"),
    assistantMessage("file-and-text-m2", "sharedneedle detail"),
  ],
};

// Uses "refactoring"/"feature-dev" (not "bugfix") so it doesn't collide with
// the recent-mid / lagging-session tag:bugfix fixtures above.
const tagMergeBoth: FixtureSpec = {
  id: "tagmerge-both",
  agent: "claudecode",
  tags: ["refactoring", "feature-dev"],
  timeUpdated: now - 13_000,
  messages: [assistantMessage("tagmerge-both-m1", "tagneedle content")],
};

const tagMergeRefactoringOnly: FixtureSpec = {
  id: "tagmerge-refactoring-only",
  agent: "claudecode",
  tags: ["refactoring"],
  timeUpdated: now - 13_100,
  messages: [assistantMessage("tagmerge-refactoring-only-m1", "tagneedle content")],
};

const tagMergeFeatDevOnly: FixtureSpec = {
  id: "tagmerge-featdev-only",
  agent: "claudecode",
  tags: ["feature-dev"],
  timeUpdated: now - 13_200,
  messages: [assistantMessage("tagmerge-featdev-only-m1", "tagneedle content")],
};

const limitSessions: FixtureSpec[] = Array.from({ length: 6 }, (_, index) => ({
  id: `limit-${index + 1}`,
  agent: "claudecode",
  tags: ["docs"] as SmartTag[],
  timeUpdated: now - 20_000 - index * 1_000,
  messages: [assistantMessage(`limit-${index + 1}-m1`, `docneedle content ${index + 1}`)],
}));

const recentOld: FixtureSpec = {
  id: "recent-old",
  agent: "claudecode",
  cost: 0.1,
  tags: [],
  project: PROJ_APP,
  timeUpdated: now - 10_000_000,
  messages: [userMessage("recent-old-m1", "needle from a long time ago")],
};

const syncedFixtures: FixtureSpec[] = [
  recentNew,
  recentMid,
  recentOld,
  codexSession,
  ftsTitle,
  ftsUser,
  ftsAssistant,
  ftsTool,
  orSessionA,
  orSessionB,
  fileOnly,
  fileAndText,
  tagMergeBoth,
  tagMergeRefactoringOnly,
  tagMergeFeatDevOnly,
  ...limitSessions,
];

const allFixtures: FixtureSpec[] = [...syncedFixtures, laggingSession];

function makeSnapshot(): SessionSearchSnapshot {
  const byAgent: Record<string, SessionHead[]> = {};
  for (const spec of allFixtures) {
    const head = makeSessionHead(spec);
    (byAgent[spec.agent] ??= []).push(head);
  }
  return {
    sessions: allFixtures.map((spec) => makeSessionHead(spec)),
    byAgent,
  };
}

function syncFixturesToSqlite(): void {
  const byAgent = new Map<string, FixtureSpec[]>();
  for (const spec of syncedFixtures) {
    const list = byAgent.get(spec.agent) ?? [];
    list.push(spec);
    byAgent.set(spec.agent, list);
  }
  for (const [agent, specs] of byAgent) {
    const heads = specs.map((spec) => makeSessionHead(spec));
    const dataById = new Map(specs.map((spec) => [spec.id, makeSessionData(spec)]));
    syncSessionSearchIndex(agent, heads, (sessionId) => dataById.get(sessionId)!);
  }
}

function search(query: string, options: SearchOptions = {}) {
  return executeSessionSearch(query, options, makeSnapshot());
}

// Sync once for the whole file rather than per-test: core memoizes "schema
// already ensured for this db path" at module scope, and that memo is only
// reset via setSchemaEnsuredPath, which isn't part of this test's concern
// here. All fixtures are read-only for the rest of the file, so a single
// shared index is sufficient and faster.
beforeAll(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
  syncFixturesToSqlite();
});

afterAll(() => {
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("search characterization: source selection", () => {
  it("routes an empty query with no file/tool filters to the recent-session (snapshot) path", () => {
    const results = search("", { limit: 50 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.matchType === "recent")).toBe(true);
  });

  it("routes a text query to the indexed FTS path", () => {
    const results = search("uniquetitleneedle", { limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["fts-title"]);
    expect(results[0]!.matchType).toBe("title");
  });

  it("routes a file= filter (no text) to the indexed file-activity path", () => {
    const results = search("", { file: "app.tsx", limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["file-only"]);
    expect(results[0]!.matchType).toBe("file_path");
  });

  it("routes a tool= filter (no text) to the indexed path, but resolves via the SQL empty-query branch (matchType stays 'recent')", () => {
    // Quirk: needsIndexedSearch treats `tools` as forcing the indexed path,
    // but since there is no text, core's searchSessions still takes its
    // "empty query" branch (ORDER BY activity_time DESC), so the shape looks
    // just like the recent path -- except results now come from the SQLite
    // index instead of the snapshot.
    const results = search("", { tools: ["bash"], limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["fts-tool"]);
    expect(results[0]!.matchType).toBe("recent");
  });

  it("a tag: qualifier alone (no text/file/tool) still routes to the recent path, not the indexed path", () => {
    // Quirk: cost/tag/agent/project qualifiers do not set needsIndexedSearch;
    // only text, file, fileKind, or tool do. So `q=tag:bugfix` alone is
    // treated identically to an empty query as far as source selection goes.
    const results = search("tag:bugfix", { limit: 50 });
    expect(results.every((r) => r.matchType === "recent")).toBe(true);
    expect(results.map((r) => r.session.id).sort()).toEqual(
      ["lagging-session", "recent-mid"].sort(),
    );
  });
});

describe("search characterization: recent (empty-query) path", () => {
  it("orders by activity time descending and applies limit", () => {
    const results = search("", { limit: 2 });
    expect(results.map((r) => r.session.id)).toEqual(["recent-new", "lagging-session"]);
  });

  it("applies the from/to activity window", () => {
    const results = search("", { from: now - 15_000, limit: 50 });
    expect(results.map((r) => r.session.id)).not.toContain("recent-old");
  });

  it("filters by agent", () => {
    const results = search("", { agent: "codex", limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["codex-session"]);
  });

  it("filters by projectKind+projectKey pair", () => {
    const results = search("", {
      projectKind: PROJ_OTHER.kind,
      projectKey: PROJ_OTHER.key,
      limit: 50,
    });
    expect(results.map((r) => r.session.id).sort()).toEqual(
      ["recent-mid", "lagging-session"].sort(),
    );
  });

  it("filters by tag", () => {
    const results = search("", { tags: ["testing"], limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["codex-session"]);
  });

  it("filters by costMin", () => {
    const results = search("", { costMin: 1, limit: 50 });
    expect(results.map((r) => r.session.id).sort()).toEqual(
      ["recent-mid", "lagging-session"].sort(),
    );
  });
});

describe("search characterization: FTS path", () => {
  it("resolves matchType per hit location: title / user_message / assistant_reply / tool_output", () => {
    expect(search("uniquetitleneedle", { limit: 50 })[0]).toMatchObject({
      session: { id: "fts-title" },
      matchType: "title",
    });
    expect(search("uniqueusermessageneedle", { limit: 50 })[0]).toMatchObject({
      session: { id: "fts-user" },
      matchType: "user_message",
    });
    expect(search("uniqueassistantneedle", { limit: 50 })[0]).toMatchObject({
      session: { id: "fts-assistant" },
      matchType: "assistant_reply",
    });
    expect(search("uniquetoolneedle", { limit: 50 })[0]).toMatchObject({
      session: { id: "fts-tool" },
      matchType: "tool_output",
    });
  });

  it("supports OR queries across sessions, breaking bm25 ties by activity time", () => {
    const results = search("alphaonlyneedle OR betaonlyneedle", { limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["or-session-a", "or-session-b"]);
  });

  it("merges a tag: qualifier from q with a tags option using AND (intersection), not override", () => {
    // Quirk: mergeSearchQueryOptions concatenates+dedupes tag lists from both
    // sources instead of letting either one win, and buildSessionSearchFilters
    // AND's every tag in the merged list. So combining a qualifier tag with an
    // options tag requires sessions to have BOTH tags, not either.
    const results = search("tagneedle tag:refactoring", { tags: ["feature-dev"], limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["tagmerge-both"]);
  });

  it("scalar qualifier/options merge: explicit costMin wins, but a leftover exclusive-comparison flag from the qualifier still applies", () => {
    // Quirk: mergeSearchQueryOptions merges costMin/costMax and their
    // *Exclusive flags independently. An explicit costMin option overrides
    // the qualifier's costMin value, but if the qualifier used a strict
    // comparison (cost:>N), its costMinExclusive=true flag survives even
    // though the numeric value it was paired with did not. Here costMin=3.5
    // ends up EXCLUSIVE because of the leftover `cost:>0.1` qualifier, so the
    // session with total_cost exactly 3.5 is excluded even though costMin=3.5
    // alone would normally read as ">=".
    const results = search("needle cost:>0.1", { costMin: 3.5, limit: 50 });
    expect(results.map((r) => r.session.id)).not.toContain("recent-mid");
  });
});

describe("search characterization: file activity path", () => {
  it("returns file_path matches for a file option", () => {
    const results = search("", { file: "app.tsx", limit: 50 });
    expect(results.map((r) => r.session.id)).toEqual(["file-only"]);
    expect(results[0]!.matchType).toBe("file_path");
  });

  it("dedupes a session hit by both file and FTS search, keeping the file_path match first", () => {
    const results = search("sharedneedle", { file: "shared.ts", limit: 50 });
    const matches = results.filter((r) => r.session.id === "file-and-text");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchType).toBe("file_path");
  });
});

describe("search characterization: limit", () => {
  it("truncates FTS results to the requested limit, preserving order", () => {
    const results = search("docneedle", { limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.session.id)).toEqual(["limit-1", "limit-2", "limit-3"]);
  });
});

describe("search characterization: recent vs SQLite-indexed equivalence (tag filter, empty query)", () => {
  it("diverges when the SQLite index lags behind the live snapshot", () => {
    // Both fixtures are tagged "bugfix": recent-mid was synced to SQLite,
    // lagging-session was deliberately left out to model index lag. The
    // recent (snapshot) path sees both; the SQLite-backed core.searchSessions
    // only sees the one it indexed. Current behavior: NOT equivalent -- the
    // recent path's result set is a strict superset of the indexed path's.
    const indexedIds = searchSessions("", { tags: ["bugfix"] })
      .map((r) => r.session.id)
      .sort();
    expect(indexedIds).toEqual(["recent-mid"]);
  });

  it("recent-path result set for the same tag filter includes the un-synced session too", () => {
    const results = search("", { tags: ["bugfix"], limit: 50 });
    expect(results.map((r) => r.session.id).sort()).toEqual(
      ["recent-mid", "lagging-session"].sort(),
    );
  });
});
