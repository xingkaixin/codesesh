import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAgent } from "../claudecode.js";
import type { Message, MessagePart, SessionHead } from "../../types/index.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

// Spies on statSync while delegating to the real implementation, so the
// single-stat regression test can count per-file calls during a live scan.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "claudecode", sessionId: id },
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

function refresh(agent: ClaudeCodeAgent, sessions: SessionHead[]) {
  return agent.sessionSourceAccess.synchronize(
    { sessions, meta: agent.snapshotSessionCacheMeta() },
    { kind: "refresh" },
  );
}

function writeMinimalClaudeSession(filePath: string): void {
  writeFileSync(
    filePath,
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-20T10:00:00Z",
      cwd: "/tmp/project",
      message: { role: "user", content: "Inspect the repository" },
    }),
  );
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  setCoreDiagnostics(null);
});

describe("ClaudeCodeAgent cache refresh", () => {
  it("detects sessions-index changes via fingerprint comparison", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-cache-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionFile = join(projectDir, "session-1.jsonl");
    const indexFile = join(projectDir, "sessions-index.json");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:00Z",
        cwd: "/tmp/project",
        message: { role: "user", content: "hello" },
      }),
    );
    writeFileSync(indexFile, JSON.stringify({ entries: [{ sessionId: "session-1" }] }));

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    // Seed baseline: a full scan populates metaMap with the source fingerprint.
    agent.scan();
    const baselineFingerprint = agent.listSessionSources()[0]?.fingerprint;
    expect(baselineFingerprint).toBeDefined();

    // No changes yet.
    const unchanged = refresh(agent, [makeSession("session-1")]);
    expect(unchanged.detectedSessionIds).toEqual([]);

    // Rewrite the index file (bumps its mtime → fingerprint changes).
    const later = new Date(Date.now() + 2000);
    writeFileSync(indexFile, JSON.stringify({ entries: [{ sessionId: "session-1" }] }), {
      flag: "w",
    });
    utimesSync(indexFile, later, later);

    const changed = refresh(agent, [makeSession("session-1")]);
    expect(changed.detectedSessionIds).toContain("session-1");
    // The fingerprint now reflects the new index mtime.
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(baselineFingerprint);
  });

  it("bounds listSessionSources to the mtime window when options are passed", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-window-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, "old-session.jsonl");
    const newFile = join(projectDir, "new-session.jsonl");
    writeFileSync(oldFile, "");
    writeFileSync(newFile, "");

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newTime = new Date();
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(
      agent
        .listSessionSources()
        .map((ref: { sessionId: string }) => ref.sessionId)
        .sort(),
    ).toEqual(["new-session", "old-session"]);

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref: { sessionId: string }) => ref.sessionId)).toEqual(["new-session"]);
  });

  it("keeps related child sources when a parent matches the scan window", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-related-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childId = "child-session";
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(childDir, { recursive: true });

    const parentFile = join(projectDir, parentId + ".jsonl");
    const childFile = join(childDir, "agent-" + childId + ".jsonl");
    writeFileSync(parentFile, "parent");
    writeFileSync(childFile, "child");
    writeFileSync(
      join(childDir, "agent-" + childId + ".meta.json"),
      JSON.stringify({ parentAgentId: null }),
    );

    const parentTime = new Date(1_700_000_100_000);
    const childTime = new Date(1_600_000_100_000);
    utimesSync(parentFile, parentTime, parentTime);
    utimesSync(childFile, childTime, childTime);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(
      agent
        .listSessionSources({
          from: parentTime.getTime() - 1,
          includeRelatedSessions: true,
        })
        .map((ref: { sessionId: string }) => ref.sessionId)
        .sort(),
    ).toEqual([parentId, childId].sort());
    expect(
      agent
        .listSessionSources({
          from: parentTime.getTime() - 1,
          includeRelatedSessions: false,
        })
        .map((ref: { sessionId: string }) => ref.sessionId),
    ).toEqual([parentId]);
  });

  it("reuses child metadata between source refreshes", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-meta-cache-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childIds = ["child-a", "child-b"];
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(projectDir, parentId + ".jsonl"), "parent");
    const metaPaths: string[] = [];

    for (const childId of childIds) {
      writeFileSync(join(childDir, "agent-" + childId + ".jsonl"), "child");
      const metaPath = join(childDir, "agent-" + childId + ".meta.json");
      metaPaths.push(metaPath);
      writeFileSync(metaPath, JSON.stringify({ name: childId }));
    }

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;
    const readSpy = vi.mocked(readFileSync);
    const statSpy = vi.mocked(statSync);

    readSpy.mockClear();
    statSpy.mockClear();
    agent.listSessionSources();
    const firstMetaReads = readSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith(".meta.json"),
    ).length;
    const firstMetaStats = statSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith(".meta.json"),
    ).length;

    readSpy.mockClear();
    statSpy.mockClear();
    agent.listSessionSources();
    const secondMetaReads = readSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith(".meta.json"),
    ).length;
    const secondMetaStats = statSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith(".meta.json"),
    ).length;

    expect(firstMetaReads).toBe(childIds.length);
    expect(firstMetaStats).toBe(childIds.length);
    expect(secondMetaReads).toBe(0);
    expect(secondMetaStats).toBe(childIds.length);

    const changedMetaTime = new Date(Date.now() + 2000);
    utimesSync(metaPaths[0]!, changedMetaTime, changedMetaTime);
    readSpy.mockClear();
    agent.listSessionSources();
    expect(
      readSpy.mock.calls.filter((call) => String(call[0]).endsWith(".meta.json")),
    ).toHaveLength(1);
  });

  it("keeps the child index when restored session metadata is equivalent", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-child-index-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childId = "child-session";
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(childDir, { recursive: true });
    writeMinimalClaudeSession(join(projectDir, parentId + ".jsonl"));
    writeMinimalClaudeSession(join(childDir, "agent-" + childId + ".jsonl"));
    writeFileSync(
      join(childDir, "agent-" + childId + ".meta.json"),
      JSON.stringify({ agentId: childId, toolUseId: "tool-child" }),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;
    agent.scan();
    const restoredMeta = agent.snapshotSessionCacheMeta();
    const walkSpy = vi.spyOn(agent, "walkFiles");

    agent.restoreSessionCacheMeta(restoredMeta);
    agent.ensureChildIndex();

    expect(walkSpy).not.toHaveBeenCalled();
    expect(agent.childSessionIdByToolUseId.get("tool-child")).toBe(childId);
  });

  it("rebuilds the child index when restored session sources change", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-child-change-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childId = "added-child";
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(projectDir, { recursive: true });
    writeMinimalClaudeSession(join(projectDir, parentId + ".jsonl"));

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;
    agent.scan();

    mkdirSync(childDir, { recursive: true });
    writeMinimalClaudeSession(join(childDir, "agent-" + childId + ".jsonl"));
    writeFileSync(
      join(childDir, "agent-" + childId + ".meta.json"),
      JSON.stringify({ agentId: childId, toolUseId: "tool-added-child" }),
    );
    const refreshedAgent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;
    refreshedAgent.scan();
    const walkSpy = vi.spyOn(agent, "walkFiles");

    agent.restoreSessionCacheMeta(refreshedAgent.snapshotSessionCacheMeta());
    agent.ensureChildIndex();

    expect(walkSpy).toHaveBeenCalledOnce();
    expect(agent.childSessionIdByToolUseId.get("tool-added-child")).toBe(childId);
  });

  it("drops a window-only child when its parent is outside the window", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-orphan-window-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childId = "child-session";
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(childDir, { recursive: true });

    const parentFile = join(projectDir, parentId + ".jsonl");
    const childFile = join(childDir, "agent-" + childId + ".jsonl");
    writeFileSync(parentFile, "parent");
    writeFileSync(childFile, "child");
    writeFileSync(join(childDir, "agent-" + childId + ".meta.json"), "{}");

    const parentTime = new Date(1_600_000_100_000);
    const childTime = new Date(1_700_000_100_000);
    utimesSync(parentFile, parentTime, parentTime);
    utimesSync(childFile, childTime, childTime);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(
      agent
        .listSessionSources({ from: childTime.getTime() - 1 })
        .map((ref: { sessionId: string }) => ref.sessionId),
    ).toEqual([]);
  });

  it("stats each session file once during a scan", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-stat-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    mkdirSync(projectDir, { recursive: true });

    const files = ["session-a.jsonl", "session-b.jsonl", "session-c.jsonl"].map((name) =>
      join(projectDir, name),
    );
    for (const file of files) {
      writeFileSync(
        file,
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: `Inspect ${file}` },
        }),
      );
    }
    const indexFile = join(projectDir, "sessions-index.json");
    writeFileSync(indexFile, JSON.stringify({ entries: [] }));

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const statSpy = vi.mocked(statSync);
    statSpy.mockClear();
    expect(agent.scan()).toHaveLength(files.length);

    for (const file of files) {
      const callsForFile = statSpy.mock.calls.filter((call) => call[0] === file);
      expect(callsForFile.length).toBe(1);
    }
  });

  it("keeps source references and fingerprints byte-for-byte stable", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-fingerprint-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionFile = join(projectDir, "session-1.jsonl");
    const indexFile = join(projectDir, "sessions-index.json");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(sessionFile, "fixture");
    writeFileSync(indexFile, JSON.stringify({ entries: [] }));

    const sessionTime = new Date(1_700_000_000_000);
    const indexTime = new Date(1_700_000_001_000);
    utimesSync(sessionFile, sessionTime, sessionTime);
    utimesSync(indexFile, indexTime, indexTime);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(agent.listSessionSources()).toEqual([
      {
        sessionId: "session-1",
        sourcePath: sessionFile,
        fingerprint: JSON.stringify([
          "claudecode-head-v7",
          sessionTime.getTime(),
          statSync(sessionFile).size,
          indexTime.getTime(),
        ]),
      },
    ]);
  });

  it("parses indexed sessions with assistant tools and tool results", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "session-1";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sessions-index.json"),
      JSON.stringify({
        entries: [{ sessionId, summary: "Indexed summary" }],
      }),
    );
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Inspect the repository" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
              output_tokens: 20,
            },
            content: [
              { type: "thinking", thinking: "Need file list" },
              { type: "text", text: "Reading package metadata" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "package.json" },
              },
              { type: "tool_use", id: "todo-1", name: "TodoWrite", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-2",
          timestamp: "2026-04-20T10:00:02Z",
          sourceToolAssistantUUID: "assistant-1",
          toolUseResult: { success: true, commandName: "read" },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  { text: "package output" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
                  },
                ],
              },
              { type: "text", text: "Continue" },
            ],
          },
        }),
        JSON.stringify({
          type: "tool_result",
          uuid: "tool-fallback",
          timestamp: "2026-04-20T10:00:03Z",
          message: { content: [{ text: "detached output" }] },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const assistant = data.messages[1];
    const readTool = assistant?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "Read",
    );

    expect(head).toMatchObject({
      reference: { agentName: "claudecode", sessionId },
      title: "Indexed summary",
      directory: "/tmp/project",
      stats: {
        message_count: 3,
        total_input_tokens: 115,
        total_output_tokens: 20,
        total_cache_read_tokens: 10,
        total_cache_create_tokens: 5,
      },
      model_usage: { "claude-sonnet-4-5-20250929": 135 },
    });
    expect(data.messages.map((message: Message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "tool",
    ]);
    expect(assistant).toMatchObject({
      agent: "claude",
      model: "claude-sonnet-4-5-20250929",
      tokens: { input: 115, output: 20, cache_read: 10, cache_create: 5 },
      cost_source: "estimated",
    });
    expect(assistant?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need file list",
    });
    expect(assistant?.parts[1]).toMatchObject({
      type: "text",
      text: "Reading package metadata",
    });
    expect(readTool).toMatchObject({
      type: "tool",
      callID: "tool-1",
      state: {
        input: { file_path: "package.json" },
        output: [
          { type: "text", text: "package output" },
          { type: "image", data: "iVBORw0KGgo=", mime_type: "image/png" },
        ],
        status: "completed",
        metadata: { commandName: "read" },
      },
    });
    expect(
      assistant?.parts.some(
        (part: MessagePart) => part.type === "tool" && part.tool === "TodoWrite",
      ),
    ).toBe(true);
    expect(data.messages[2]?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
    expect(data.messages[3]).toMatchObject({
      role: "tool",
      parts: [{ type: "text", text: "detached output" }],
    });
  });

  it("discovers Claude subagents and links Agent calls to child sessions", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-subagent-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const parentId = "parent-session";
    const childId = "child-session";
    const nestedChildId = "nested-child-session";
    const childDir = join(projectDir, parentId, "subagents");
    mkdirSync(childDir, { recursive: true });

    writeFileSync(
      join(projectDir, parentId + ".jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Delegate the repository check" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-agent-1",
                name: "Agent",
                input: { prompt: "Inspect the repository" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-2",
          timestamp: "2026-04-20T10:00:02Z",
          sourceToolAssistantUUID: "assistant-1",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-agent-1",
                content: "Child completed",
              },
            ],
          },
        }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(childDir, "agent-" + childId + ".meta.json"),
      JSON.stringify({
        name: "repository-check",
        description: "Inspect the repository",
        toolUseId: "tool-agent-1",
      }),
    );
    writeFileSync(
      join(childDir, "agent-" + childId + ".jsonl"),
      [
        JSON.stringify({
          type: "user",
          agentId: childId,
          isSidechain: true,
          timestamp: "2026-04-20T10:00:01Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Inspect the repository" },
        }),
        JSON.stringify({
          type: "assistant",
          agentId: childId,
          isSidechain: true,
          timestamp: "2026-04-20T10:00:03Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Repository is clean" }],
          },
        }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(childDir, "agent-" + nestedChildId + ".meta.json"),
      JSON.stringify({
        description: "Nested repository check",
        parentAgentId: childId,
      }),
    );
    writeFileSync(
      join(childDir, "agent-" + nestedChildId + ".jsonl"),
      [
        JSON.stringify({
          type: "user",
          agentId: nestedChildId,
          isSidechain: true,
          timestamp: "2026-04-20T10:00:02Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Check the repository again" },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const heads = agent.scan();
    const parent = heads.find((head: SessionHead) => head.reference.sessionId === parentId);
    const child = heads.find((head: SessionHead) => head.reference.sessionId === childId);

    expect(heads.map((head: SessionHead) => head.reference.sessionId).sort()).toEqual(
      [parentId, childId, nestedChildId].sort(),
    );
    expect(child).toMatchObject({
      title: "repository-check",
      parent_reference: { agentName: "claudecode", sessionId: parentId },
    });
    expect(
      heads.find((head: SessionHead) => head.reference.sessionId === nestedChildId),
    ).toMatchObject({
      title: "Nested repository check",
      parent_reference: { agentName: "claudecode", sessionId: childId },
    });
    expect(parent?.parent_reference).toBeUndefined();

    const parentData = agent.getSessionData(parentId);
    const agentMessage = parentData.messages.find((message: Message) =>
      message.parts.some((part: MessagePart) => part.type === "tool" && part.tool === "Agent"),
    );
    expect(agentMessage?.subagent_id).toBe(childId);
    expect(agent.getSessionData(childId)).toMatchObject({
      reference: { agentName: "claudecode", sessionId: childId },
      parent_reference: { agentName: "claudecode", sessionId: parentId },
      messages: [
        { role: "user" },
        { role: "assistant", parts: [{ type: "text", text: "Repository is clean" }] },
      ],
    });
  });

  it("counts repeated Claude request usage once across assistant fragments", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "session-fragments";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
    };

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Inspect the repository" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-thinking",
          parentUuid: "user-1",
          requestId: "req-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage,
            content: [{ type: "thinking", thinking: "Need file list" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-tool",
          parentUuid: "assistant-thinking",
          requestId: "req-1",
          timestamp: "2026-04-20T10:00:02Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage,
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "package.json" },
              },
            ],
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(head?.stats).toMatchObject({
      total_input_tokens: 115,
      total_output_tokens: 20,
      total_cache_read_tokens: 10,
      total_cache_create_tokens: 5,
      total_cost: 0.00062175,
    });
    expect(head?.model_usage).toEqual({ "claude-sonnet-4-5-20250929": 135 });
    expect(data.stats).toMatchObject({
      total_input_tokens: 115,
      total_output_tokens: 20,
      total_cache_read_tokens: 10,
      total_cache_create_tokens: 5,
      total_cost: 0.00062175,
    });
    expect(data.messages.filter((message: Message) => (message.cost ?? 0) > 0)).toHaveLength(1);
  });

  it("filters internal-only sessions", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "internal-only.jsonl"),
      [
        JSON.stringify({
          type: "progress",
          timestamp: "2026-04-20T10:00:00Z",
          message: { role: "", content: "" },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(agent.scan()).toEqual([]);
  });

  it("cleans internal tag blocks from visible messages", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "tagged-session";

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content:
              "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>Visible request</command-args>\n<local-command-caveat>noise</local-command-caveat>\n<local-command-stdout>noise</local-command-stdout>",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Visible answer <system-reminder>hidden</system-reminder>",
              },
            ],
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(head?.title).toBe("Visible request");
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible answer" }),
    ]);
  });

  it("filters internal-only local command sessions", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-local-command-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "local-command.jsonl"),
      [
        JSON.stringify({ type: "queue-operation", timestamp: "2026-04-20T10:00:00Z" }),
        JSON.stringify({
          type: "user",
          isMeta: true,
          timestamp: "2026-04-20T10:00:01Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: "<local-command-caveat>Internal command context</local-command-caveat>",
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-20T10:00:02Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content:
              "<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>",
          },
        }),
        JSON.stringify({
          type: "system",
          subtype: "local_command",
          timestamp: "2026-04-20T10:00:03Z",
          content: "Internal output",
        }),
        JSON.stringify({ type: "last-prompt" }),
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(agent.scan()).toEqual([]);
  });

  it("falls back to zero and reports a mismatch when a usage field has the wrong type", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-usage-drift-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "usage-drift";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Inspect the repository" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage: {
              // Drifted upstream shape: input_tokens sent as a string.
              input_tokens: "100",
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
              output_tokens: 20,
            },
            content: [{ type: "text", text: "Reading package metadata" }],
          },
        }),
        "",
      ].join("\n"),
    );

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    const [head] = agent.scan();

    // input_tokens falls back to 0 (still counting cache_read + cache_create); other fields unaffected.
    expect(head?.stats).toMatchObject({
      total_input_tokens: 15,
      total_output_tokens: 20,
      total_cache_read_tokens: 10,
      total_cache_create_tokens: 5,
    });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "claudecode", field: "message.usage.input_tokens" },
    });
  });

  it("skips message extraction and reports a mismatch when the message field is not an object", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-message-drift-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "message-drift";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          // Drifted upstream shape: message sent as a plain string, not an object.
          message: "not-an-object",
        }),
        "",
      ].join("\n"),
    );

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    // No visible messages were extracted, so the session is filtered out entirely.
    expect(agent.scan()).toEqual([]);
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "claudecode", field: "message" },
    });
  });
});

describe("ClaudeCodeAgent head parsing", () => {
  function writeSession(lines: string[]): { agent: ClaudeCodeAgent; sessionFile: string } {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-head-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-1.jsonl");
    writeFileSync(sessionFile, lines.join("\n"));

    return { agent: new ClaudeCodeAgent({ sourceRoot: basePath }), sessionFile };
  }

  function userLine(text: string, timestamp = "2026-04-20T10:00:00Z"): string {
    return JSON.stringify({
      type: "user",
      timestamp,
      cwd: "/tmp/project",
      message: { role: "user", content: text },
    });
  }

  it("skips an empty file", () => {
    expect(writeSession([]).agent.scan()).toEqual([]);
    expect(writeSession(["", "   ", ""]).agent.scan()).toEqual([]);
  });

  it("treats a child with missing metadata and parent as a root", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-orphan-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const childDir = join(projectDir, "missing-parent", "subagents");
    const childId = "orphan-child";
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "agent-" + childId + ".jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:00Z",
        cwd: "/tmp/project",
        message: { role: "user", content: "Orphan child" },
      }),
    );

    const agent = new ClaudeCodeAgent({ sourceRoot: basePath }) as any;

    expect(agent.scan()).toMatchObject([
      {
        reference: { agentName: "claudecode", sessionId: childId },
        title: "Orphan child",
        parent_reference: undefined,
      },
    ]);
  });

  it("skips a file whose first record is malformed", () => {
    expect(writeSession(["not json", userLine("Visible")]).agent.scan()).toEqual([]);
  });

  it("skips a malformed record after the first without dropping the session", () => {
    const [head] = writeSession([userLine("First"), "not json", userLine("Third")]).agent.scan();

    expect(head?.title).toBe("First");
    expect(head?.stats.message_count).toBe(2);
  });

  it("falls back to the file mtime when the first record has no timestamp", () => {
    const { agent, sessionFile } = writeSession([
      JSON.stringify({
        type: "user",
        cwd: "/tmp/project",
        message: { role: "user", content: "A" },
      }),
    ]);

    const [head] = agent.scan();

    expect(head?.time_created).toBe(statSync(sessionFile).mtimeMs);
  });

  it("preserves explicit timezone offsets", () => {
    const [head] = writeSession([
      userLine("First", "2026-04-20T10:00:00+08:00"),
      userLine("Second", "2026-04-20T10:02:30+08:00"),
    ]).agent.scan();

    expect(head?.time_created).toBe(Date.parse("2026-04-20T10:00:00+08:00"));
    expect(head?.time_updated).toBe(Date.parse("2026-04-20T10:02:30+08:00"));
  });

  it("only considers the first 20 records for the fallback title", () => {
    // Malformed records still advance the window, matching the pre-streaming
    // behaviour where the index came from the raw non-blank line list.
    const filler = Array.from({ length: 19 }, () =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-20T10:00:00Z",
        cwd: "/tmp/project",
        message: { role: "assistant", content: [{ type: "text", text: "filler" }] },
      }),
    );

    const inWindow = writeSession([...filler, userLine("Twentieth record")]).agent.scan();
    expect(inWindow[0]?.title).toBe("Twentieth record");

    const outOfWindow = writeSession([
      ...filler,
      filler[0]!,
      userLine("Twenty-first record"),
    ]).agent.scan();
    expect(outOfWindow[0]?.title).toBe("project");
  });

  it("reads records that straddle a read-chunk boundary", () => {
    const marker = "结束标记";
    const padding = "x".repeat(1024 * 1024);
    const [head] = writeSession([userLine(`${padding}${marker}`)]).agent.scan();

    expect(head?.title).toBe(`${padding}${marker}`.slice(0, 100));
  });
});
