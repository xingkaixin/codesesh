import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KimiAgent } from "../kimi.js";
import type { SessionHead } from "../../types/index.js";

const PROJECT_HASH = "project-hash";
const PROJECT_DIR = "/tmp/kimi-project";

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `kimi/${id}`,
    title: id,
    directory: PROJECT_DIR,
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

function createAgent(basePath: string): KimiAgent {
  const agent = new KimiAgent() as any;
  agent.basePath = basePath;
  agent.projectMap = new Map([[PROJECT_HASH, PROJECT_DIR]]);
  return agent as KimiAgent;
}

function createSessionDir(basePath: string, id: string, title: string, mtimeMs: number): string {
  const sessionDir = join(basePath, PROJECT_HASH, id);
  mkdirSync(sessionDir, { recursive: true });

  const statePath = join(sessionDir, "state.json");
  const contextPath = join(sessionDir, "context.jsonl");
  writeFileSync(
    statePath,
    JSON.stringify({
      custom_title: title,
      wire_mtime: Math.floor(mtimeMs / 1000),
    }),
  );
  writeFileSync(contextPath, JSON.stringify({ role: "user", content: title }) + "\n");

  const mtime = new Date(mtimeMs);
  utimesSync(statePath, mtime, mtime);
  utimesSync(contextPath, mtime, mtime);

  return sessionDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("KimiAgent cache refresh", () => {
  it("detects added session directories during cache validation", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const cachedAt = 2_000;
    createSessionDir(basePath, "old-session", "Old", 1_000);
    createSessionDir(basePath, "new-session", "New", 1_000);

    const agent = createAgent(basePath);

    const result = agent.checkForChanges(cachedAt, [makeSession("old-session")]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["new-session"]);
  });

  it("adds changed session directories during incremental scan", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "old-session", "Old", 1_000);
    createSessionDir(basePath, "new-session", "New", 1_000);

    const agent = createAgent(basePath);
    const sessions = agent.incrementalScan([makeSession("old-session")], ["new-session"]);

    expect(sessions.map((session) => session.id).sort()).toEqual(["new-session", "old-session"]);
    expect(sessions.find((session) => session.id === "new-session")).toMatchObject({
      slug: "kimi/new-session",
      title: "New",
      directory: PROJECT_DIR,
    });
  });

  it("removes deleted sessions during incremental scan", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "old-session", "Old", 1_000);

    const agent = createAgent(basePath);
    const sessions = agent.incrementalScan(
      [makeSession("old-session"), makeSession("deleted-session")],
      ["deleted-session"],
    );

    expect(sessions.map((session) => session.id)).toEqual(["old-session"]);
    expect(agent.getSessionMetaMap().has("deleted-session")).toBe(false);
  });

  it("parses context messages with tool calls and backfilled output", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "context-session", "Context", 1_000);
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      [
        JSON.stringify({ role: "user", content: "Read package.json" }),
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "think", think: "Need to inspect the file" },
            { type: "text", text: "Reading it now" },
          ],
          tool_calls: [
            {
              id: "call-1",
              function: { name: "ReadFile", arguments: '{"path":"package.json"}' },
            },
          ],
        }),
        JSON.stringify({
          role: "tool",
          tool_call_id: "call-1",
          content: [{ text: '{ "name": "codesesh-monorepo" }' }],
        }),
        "",
      ].join("\n"),
    );

    const agent = createAgent(basePath);
    agent.scan();

    const data = agent.getSessionData("context-session");
    const toolPart = data.messages[1]?.parts[2];

    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]?.role).toBe("user");
    expect(data.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Read package.json",
    });
    expect(data.messages[1]?.role).toBe("assistant");
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need to inspect the file",
    });
    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "ReadFile",
      title: "read",
      state: {
        arguments: { path: "package.json" },
        output: [{ type: "text", text: '{ "name": "codesesh-monorepo" }' }],
      },
    });
  });
});
