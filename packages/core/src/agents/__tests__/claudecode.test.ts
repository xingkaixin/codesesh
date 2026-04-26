import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "../claudecode.js";
import type { SessionHead } from "../../types/index.js";

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `claudecode/${id}`,
    title: id,
    directory: "/tmp/project",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

describe("ClaudeCodeAgent cache refresh", () => {
  it("revalidates recent sessions and invalidates sessions index cache", () => {
    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = "/tmp/claudecode";
    agent.sessionsIndexCache = { project: new Map([["stale", {}]]) };
    agent.sessionMetaMap = new Map([
      [
        "session-1",
        {
          id: "session-1",
          title: "Old",
          sourcePath: "/tmp/claudecode/project/session-1.jsonl",
          directory: "/tmp/project",
          model: null,
          messageCount: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    ]);

    const now = Date.now();
    const result = agent.checkForChanges(now, [
      makeSession("session-1", { time_created: now - 60_000 }),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("session-1");
    expect(agent.sessionsIndexCache.project).toBeUndefined();
  });
});

describe("ClaudeCodeAgent session alias (cc-native custom-title upsert)", () => {
  let baseDir: string;
  let projectDir: string;
  let sessionFile: string;
  const sessionId = "abcd-1234";

  function readJsonl(): Array<Record<string, unknown>> {
    return readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  function buildAgent(): { agent: ClaudeCodeAgent; raw: any } {
    const agent = new ClaudeCodeAgent();
    const raw = agent as any;
    raw.basePath = baseDir;
    raw.sessionsIndexCache = {};
    raw.sessionMetaMap = new Map([
      [
        sessionId,
        {
          id: sessionId,
          title: "Old",
          sourcePath: sessionFile,
          directory: "/tmp/project",
          model: null,
          messageCount: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    ]);
    return { agent, raw };
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "codesesh-claudecode-"));
    projectDir = join(baseDir, "project");
    mkdirSync(projectDir, { recursive: true });
    sessionFile = join(projectDir, `${sessionId}.jsonl`);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("prepends a custom-title record when none exists", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          parentUuid: null,
          type: "user",
          message: { role: "user", content: "hello world" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "  My Custom Title  ");

    expect(head?.title).toBe("My Custom Title");
    const records = readJsonl();
    expect(records[0]).toEqual({
      type: "custom-title",
      customTitle: "My Custom Title",
      sessionId,
    });
    expect(records).toHaveLength(2);
  });

  it("collapses cc's append-on-resume duplicates into a single fresh row", () => {
    // cc itself writes a new custom-title row on every resume, so a long-lived
    // session may accumulate several of them. setSessionAlias should leave at
    // most one row behind regardless of how many were there before.
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "custom-title", customTitle: "Old name 1", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
        JSON.stringify({ type: "custom-title", customTitle: "Old name 2", sessionId }),
        JSON.stringify({ type: "custom-title", customTitle: "Old name 3", sessionId }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "Fresh name");

    expect(head?.title).toBe("Fresh name");
    const records = readJsonl();
    const titleRows = records.filter((r) => r["type"] === "custom-title");
    expect(titleRows).toHaveLength(1);
    expect(titleRows[0]?.["customTitle"]).toBe("Fresh name");
    // user message preserved
    expect(records.filter((r) => r["type"] === "user")).toHaveLength(1);
  });

  it("reads the LAST custom-title row when several exist (matches cc's /resume)", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "custom-title", customTitle: "First", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
        JSON.stringify({ type: "custom-title", customTitle: "Latest cc --name", sessionId }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent, raw } = buildAgent();
    // No write, just observe parseSessionHead reading existing rows.
    const head = raw.parseSessionHead(sessionFile, projectDir);
    expect(head?.title).toBe("Latest cc --name");
    // setSessionAlias (no-op clear when nothing) leaves both rows since we
    // didn't ask to rewrite anything.
    void agent;
  });

  it("prefers custom-title over hook-emitted summary on read", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "summary", summary: "Hook says X", source: "session-end-hook" }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "User override");
    expect(head?.title).toBe("User override");

    const records = readJsonl();
    // The hook summary stays untouched — codesesh only owns custom-title rows.
    expect(records.filter((r) => r["source"] === "session-end-hook")).toHaveLength(1);
    expect(records.filter((r) => r["type"] === "custom-title")).toHaveLength(1);
  });

  it("removes custom-title rows when cleared and falls back to hook summary", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "summary", summary: "Hook says X", source: "session-end-hook" }),
        JSON.stringify({ type: "custom-title", customTitle: "Old alias", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "");
    expect(head?.title).toBe("Hook says X");

    const records = readJsonl();
    expect(records.some((r) => r["type"] === "custom-title")).toBe(false);
    // hook record + user message
    expect(records).toHaveLength(2);
  });

  it("falls back to first user message when no metadata records remain", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "actual first prompt text" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, null);
    // No alias was set, file should be untouched and parseSessionHead
    // should derive the title from the first user message.
    expect(head?.title).toBe("actual first prompt text");
    const records = readJsonl();
    expect(records).toHaveLength(1);
  });

  it("returns null for unknown sessions without touching the filesystem", () => {
    writeFileSync(sessionFile, "", "utf-8");
    const { agent } = buildAgent();
    expect(agent.setSessionAlias("does-not-exist", "Whatever")).toBeNull();
    expect(readFileSync(sessionFile, "utf-8")).toBe("");
  });
});
