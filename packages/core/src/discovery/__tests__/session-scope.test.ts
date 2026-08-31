import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionHead } from "../../types/index.js";
import {
  executeSessionSearch,
  filterSessionSearchCandidates,
} from "../../search/session-search.js";
import { closeCacheStorage } from "../cache/db.js";
import { listFileActivity } from "../cache/file-activity.js";
import { syncSessionSearchIndex } from "../cache/search.js";
import { saveCachedSessions } from "../cache/sessions.js";
import { makeSessionHead } from "../cache/__tests__/fixtures.js";
import { matchesSessionQueryScope, type SessionQueryScope } from "../session-scope.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-query-scope-"));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testHomeDir,
}));

const queryScope: SessionQueryScope = {
  agents: ["codex"],
  projectScope: {
    identity: { kind: "path", key: "/workspace/allowed" },
    path: "/workspace/allowed",
  },
};

function makeDetail(id: string, agentName: string, directory: string, time: number): SessionDetail {
  return {
    ...makeSessionHead(id, {
      reference: { agentName, sessionId: id },
      title: "needle",
      directory,
      project_identity: { kind: "path", key: directory, displayName: id },
      time_created: time,
      time_updated: time,
    }),
    messages: [
      {
        id: `${id}-message`,
        role: "assistant",
        time_created: time,
        parts: [
          { type: "text", text: "needle" },
          {
            type: "tool",
            tool: "Read",
            state: { status: "completed", input: { file_path: "src/shared.ts" } },
          },
        ],
      },
    ],
  };
}

const details = [
  {
    ...makeDetail("dot-escape", "codex", "/workspace/other", 700),
    directory: "/workspace/allowed/../other",
  },
  { ...makeDetail("empty-directory", "codex", "/workspace/unrelated", 600), directory: "" },
  makeDetail("different-case", "codex", "/workspace/ALLOWED", 500),
  makeDetail("other-agent", "claudecode", "/workspace/allowed", 400),
  makeDetail("other-project", "codex", "/outside/project", 300),
  makeDetail("visible", "codex", "/workspace/allowed", 200),
  makeDetail("trailing-parent", "codex", "/workspace/", 150),
  {
    ...makeDetail("historical", "codex", "/worktrees/allowed", 100),
    project_identity: { kind: "path" as const, key: "/workspace/allowed", displayName: "allowed" },
  },
];
const heads = details.map(({ messages: _messages, ...head }) => head);
const byAgent: Record<string, SessionHead[]> = {};
for (const head of heads) (byAgent[head.reference.agentName] ??= []).push(head);
const fullSnapshot = { sessions: heads, byAgent };
const visible = heads.find((head) => head.reference.sessionId === "visible")!;
const partialSnapshot = { sessions: [visible], byAgent: { codex: [visible] } };
const allowedIds = ["visible", "trailing-parent", "historical"];

beforeAll(() => {
  for (const [agentName, sessions] of Object.entries(byAgent)) {
    saveCachedSessions(agentName, sessions);
    syncSessionSearchIndex(agentName, sessions, (id) =>
      details.find((detail) => detail.reference.sessionId === id)!,
    );
  }
});

afterAll(() => {
  closeCacheStorage();
  rmSync(testHomeDir, { recursive: true, force: true });
});

describe("instance session query scope", () => {
  it("applies the same scope before limits across recent, text, and file queries", () => {
    const context = { queryScope };
    for (const query of ["", "needle", "file:shared.ts"]) {
      const results = executeSessionSearch(query, { limit: 1 }, fullSnapshot, context);
      expect(results.map((result) => result.reference.sessionId)).toEqual(["visible"]);
    }
    expect(
      listFileActivity({ limit: 1 }, queryScope).map((row) => row.reference.sessionId),
    ).toEqual(["visible"]);
  });

  it("keeps indexed history in the instance scope when the live snapshot is incomplete", () => {
    const results = executeSessionSearch("needle", { limit: 3 }, partialSnapshot, { queryScope });
    expect(results.map((result) => result.reference.sessionId)).toEqual(allowedIds);
    expect(results.every((result) => matchesSessionQueryScope(result.session, queryScope))).toBe(
      true,
    );
  });

  it("matches memory and SQL rules for empty paths, casing, dot segments, and trailing slashes", () => {
    closeCacheStorage();
    for (const query of ["", "needle"]) {
      const results = executeSessionSearch(query, {}, fullSnapshot, { queryScope });
      expect(results.map((result) => result.reference.sessionId)).toEqual(allowedIds);
    }
    expect(listFileActivity({}, queryScope).map((row) => row.reference.sessionId)).toEqual(
      allowedIds,
    );
  });

  it("intersects user agent and project filters with the instance scope", () => {
    const context = { queryScope };
    expect(executeSessionSearch("agent:claudecode needle", {}, fullSnapshot, context)).toEqual([]);
    expect(executeSessionSearch("", { agent: "claudecode" }, fullSnapshot, context)).toEqual([]);
    const outsideProject = {
      identity: { kind: "path" as const, key: "/outside/project" },
      path: "/outside/project",
    };
    expect(
      executeSessionSearch("needle", { projectScope: outsideProject }, fullSnapshot, context),
    ).toEqual([]);
    expect(listFileActivity({ agent: "claudecode" }, queryScope)).toEqual([]);
    expect(listFileActivity({ projectScope: outsideProject }, queryScope)).toEqual([]);
  });

  it("keeps alias candidates inside the same scope", () => {
    const candidates = executeSessionSearch("", {}, fullSnapshot);
    const results = filterSessionSearchCandidates(
      candidates,
      { file: "shared.ts" },
      { queryScope },
    );
    expect(results.map((result) => result.reference.sessionId)).toEqual(allowedIds);
  });
});
