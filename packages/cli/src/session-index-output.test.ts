import { describe, expect, it } from "vitest";
import type { IdentifiedSessionHead, LiveSnapshot } from "@codesesh/core";
import {
  buildSessionIndexOutput,
  formatCacheFailureDiagnostics,
  formatScanFailureDiagnostics,
} from "./session-index-output.js";

function makeSession(id: string, activity: number): IdentifiedSessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/workspace",
    project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
    time_created: activity,
    time_updated: activity,
    stats: {
      message_count: 3,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_cost: 0.01,
    },
  };
}

function makeSnapshot(
  sessions: IdentifiedSessionHead[],
): Pick<LiveSnapshot, "sessions" | "byAgent"> {
  return { sessions, byAgent: { codex: sessions } };
}

/** Fields the README promises; anything beyond this would make --json an archive. */
const DOCUMENTED_SESSION_FIELDS = [
  "directory",
  "id",
  "project_identity",
  "reference",
  "slug",
  "stats",
  "time_created",
  "time_updated",
  "title",
];

describe("CS-150: --json is a session index", () => {
  it("reports agents and session heads only", () => {
    const output = buildSessionIndexOutput(makeSnapshot([makeSession("s1", 100)]));

    expect(Object.keys(output).sort()).toEqual(["agents", "sessions"]);
    expect(output.agents.find((agent) => agent.name === "codex")).toMatchObject({
      count: 1,
      available: true,
    });
    expect(Object.keys(output.sessions[0]!).sort()).toEqual(DOCUMENTED_SESSION_FIELDS);
  });

  it.each(["messages", "file_activity", "parts", "reasoning"])("does not carry %s", (field) => {
    const output = buildSessionIndexOutput(makeSnapshot([makeSession("s1", 100)]));

    expect(output.sessions[0]).not.toHaveProperty(field);
  });

  it("applies the time window to the index", () => {
    const output = buildSessionIndexOutput(
      makeSnapshot([makeSession("old", 100), makeSession("new", 5_000)]),
      { from: 1_000 },
    );

    expect(output.sessions.map((session) => session.id)).toEqual(["new"]);
  });

  it("filters by parent activity while retaining child sessions", () => {
    const parent = makeSession("parent", 5_000);
    const child = {
      ...makeSession("child", 100),
      parent_reference: { agentName: "codex", sessionId: "parent" },
    };

    const output = buildSessionIndexOutput(makeSnapshot([parent, child]), { from: 1_000 });

    expect(output.sessions.map((session) => session.id)).toEqual(["parent", "child"]);
    expect(output.agents.find((agent) => agent.name === "codex")?.count).toBe(2);
  });

  it("reports an agent with no sessions as unavailable", () => {
    const output = buildSessionIndexOutput({ sessions: [], byAgent: { codex: [] } });

    expect(output.agents.find((agent) => agent.name === "codex")).toMatchObject({
      count: 0,
      available: false,
    });
  });
});

describe("scan failure diagnostics", () => {
  it("formats agent-level failures without inventing a session", () => {
    expect(
      formatScanFailureDiagnostics({
        scanFailures: {
          codex: {
            agentName: "codex",
            stage: "enumerating session sources",
            sourcePath: "/sessions",
            errorClass: "EACCES",
            message: "permission denied",
          },
        },
      }),
    ).toEqual([
      "[codex] Scan failed during enumerating session sources at /sessions (EACCES): permission denied",
    ]);
  });
});

describe("cache failure diagnostics", () => {
  it("reports degraded persistence without treating the scan as failed", () => {
    expect(
      formatCacheFailureDiagnostics({
        cacheFailures: { codex: { agentName: "codex" } },
      }),
    ).toEqual([
      "[codex] Cache persistence failed; serving in-memory results without advancing the durable baseline",
    ]);
  });
});
