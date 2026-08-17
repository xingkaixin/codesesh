import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KimiCodeAgent } from "../kimi-code.js";

const SESSION_ID = "ses_test-kimi-code";
const WORK_DIR = "/tmp/kimi-code-project";

let tempDirs: string[] = [];

function createAgent(dataRoot: string): KimiCodeAgent {
  const agent = new KimiCodeAgent() as never as { basePath: string };
  agent.basePath = join(dataRoot, "sessions");
  return agent as never as KimiCodeAgent;
}

function createSession(
  dataRoot: string,
  wire: Record<string, unknown>[],
  sessionId = SESSION_ID,
): string {
  const sessionDir = join(dataRoot, "sessions", "wd_project_hash", sessionId);
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(sessionDir, "state.json"),
    JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      title: "",
      agents: { main: { homedir: join(sessionDir, "agents", "main") } },
    }),
  );
  const wireFile = join(sessionDir, "agents", "main", "wire.jsonl");
  writeFileSync(wireFile, wire.map((record) => JSON.stringify(record)).join("\n") + "\n");
  utimesSync(wireFile, 1767225607, 1767225607);
  writeFileSync(
    join(dataRoot, "session_index.jsonl"),
    `${JSON.stringify({ sessionId, sessionDir, workDir: WORK_DIR })}\n`,
  );
  return sessionDir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("KimiCodeAgent", () => {
  it("enumerates an old session by recent wire activity", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    const sessionDir = createSession(dataRoot, [
      { type: "context.append_message", message: { role: "user", content: "Continue" } },
    ]);
    const recentActivity = Date.parse("2026-02-01T00:00:00.000Z");
    const wireFile = join(sessionDir, "agents", "main", "wire.jsonl");
    utimesSync(wireFile, recentActivity / 1000, recentActivity / 1000);
    const agent = createAgent(dataRoot);
    const from = Date.parse("2026-01-25T00:00:00.000Z");

    const refs = agent.listSessionSources({ from });
    const [head] = agent.scan({ from });
    const meta = agent.getSessionMetaMap().get(SESSION_ID);

    expect(refs).toHaveLength(1);
    expect(head).toMatchObject({
      time_created: Date.parse("2026-01-01T00:00:00.000Z"),
      time_updated: recentActivity,
    });
    expect(meta?.sourceMtimeMs).toBe(recentActivity);
    expect(meta?.sourceMtimeMs).toBe(head?.time_updated);
    expect(meta?.sourceFingerprint).toBe(refs[0]?.fingerprint);
  });

  it("changes the source fingerprint when the wire grows with a preserved mtime", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    const sessionDir = createSession(dataRoot, [
      { type: "context.append_message", message: { role: "user", content: "First" } },
    ]);
    const wireFile = join(sessionDir, "agents", "main", "wire.jsonl");
    const pinnedMtime = statSync(wireFile).mtimeMs;
    const agent = createAgent(dataRoot);
    const before = agent.listSessionSources()[0]?.fingerprint;

    appendFileSync(
      wireFile,
      `${JSON.stringify({
        type: "context.append_message",
        message: { role: "assistant", content: "Second" },
      })}\n`,
    );
    utimesSync(wireFile, pinnedMtime / 1000, pinnedMtime / 1000);

    expect(statSync(wireFile).mtimeMs).toBe(pinnedMtime);
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(before);
  });

  it("invalidates a cached head from an older parser revision", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    const sessionDir = createSession(dataRoot, [
      { type: "context.append_message", message: { role: "user", content: "Refresh me" } },
    ]);
    const agent = createAgent(dataRoot);
    const heads = agent.scan();
    const currentMeta = agent.getSessionMetaMap().get(SESSION_ID)!;
    if (typeof currentMeta.sourceFingerprint !== "string") {
      throw new TypeError("Expected Kimi-Code source fingerprint");
    }
    const fingerprint = JSON.parse(currentMeta.sourceFingerprint) as unknown[];
    expect(fingerprint[0]).toBe("kimi-code-parser-v2");
    expect(fingerprint[2]).toBe(statSync(join(sessionDir, "state.json")).size);
    expect(fingerprint[4]).toBe(statSync(join(sessionDir, "agents", "main", "wire.jsonl")).size);
    agent.setSessionMetaMap(
      new Map([
        [
          SESSION_ID,
          {
            ...currentMeta,
            sourceFingerprint: JSON.stringify(["kimi-code-parser-v0", ...fingerprint.slice(1)]),
          },
        ],
      ]),
    );

    const changes = agent.checkForChanges(0, heads);
    expect(changes.changedIds).toContain(SESSION_ID);
    const refreshed = agent.incrementalScan(heads, changes.changedIds ?? [], changes.refs);
    expect(refreshed).toMatchObject([{ id: SESSION_ID, title: "Refresh me" }]);
    expect(agent.getSessionMetaMap().get(SESSION_ID)?.sourceFingerprint).toBe(
      changes.refs?.[0]?.fingerprint,
    );
    expect(agent.getSessionData(SESSION_ID).messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Refresh me" }],
    });
  });

  it("discovers workdir-keyed sessions and rebuilds loop events", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    const sessionDir = createSession(dataRoot, [
      { type: "metadata", protocol_version: "1.4", created_at: 1767225600000 },
      {
        type: "context.append_message",
        time: 1767225601000,
        message: { role: "user", content: [{ type: "text", text: "Read package.json" }] },
      },
      {
        type: "context.append_loop_event",
        time: 1767225602000,
        event: { type: "step.begin", uuid: "step-1", turnId: "0", step: 1 },
      },
      {
        type: "llm.request",
        time: 1767225602001,
        provider: "kimi",
        model: "moonshot-cn/kimi-k2.7-code",
      },
      {
        type: "context.append_loop_event",
        time: 1767225603000,
        event: {
          type: "content.part",
          stepUuid: "step-1",
          part: { type: "think", think: "Inspect the package manifest" },
        },
      },
      {
        type: "context.append_loop_event",
        time: 1767225604000,
        event: {
          type: "tool.call",
          stepUuid: "step-1",
          toolCallId: "call-1",
          name: "ReadFile",
          args: { path: "package.json" },
        },
      },
      {
        type: "context.append_loop_event",
        time: 1767225605000,
        event: {
          type: "tool.result",
          stepUuid: "step-1",
          toolCallId: "call-1",
          result: { output: '{"name":"codesesh"}', isError: false },
        },
      },
      {
        type: "context.append_loop_event",
        time: 1767225606000,
        event: {
          type: "content.part",
          stepUuid: "step-1",
          part: { type: "text", text: "I found the package manifest." },
        },
      },
      {
        type: "context.append_loop_event",
        time: 1767225607000,
        event: { type: "step.end", uuid: "step-1" },
      },
      {
        type: "usage.record",
        time: 1767225608000,
        model: "moonshot-cn/kimi-k2.7-code",
        usage: { inputOther: 10, inputCacheRead: 2, inputCacheCreation: 1, output: 4 },
        usageScope: "turn",
      },
      {
        type: "context.append_loop_event",
        time: 1767225609000,
        event: { type: "step.begin", uuid: "step-2", turnId: "0", step: 2 },
      },
      {
        type: "context.append_loop_event",
        time: 1767225610000,
        event: {
          type: "content.part",
          stepUuid: "step-2",
          part: { type: "text", text: "The next step is separate." },
        },
      },
      {
        type: "context.append_loop_event",
        time: 1767225611000,
        event: { type: "step.end", uuid: "step-2" },
      },
    ]);

    const agent = createAgent(dataRoot);
    const refs = agent.listSessionSources();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sourcePath).toBe(sessionDir);
    expect(agent.listSessionSources({ from: 1767225599000, to: 1767225661000 })).toHaveLength(1);

    writeFileSync(
      join(dataRoot, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: "/tmp/renamed-project" })}\n`,
    );
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(refs[0]?.fingerprint);

    const [head] = agent.scan();
    expect(head).toMatchObject({
      id: SESSION_ID,
      slug: `kimi-code/${SESSION_ID}`,
      title: "Read package.json",
      directory: "/tmp/renamed-project",
      time_created: 1767225600000,
      time_updated: 1767225660000,
      stats: {
        message_count: 3,
        total_input_tokens: 13,
        total_output_tokens: 4,
        total_tokens: 17,
        total_cache_read_tokens: 2,
        total_cache_create_tokens: 1,
      },
      model_usage: { "moonshot-cn/kimi-k2.7-code": 17 },
    });

    const detail = agent.getSessionData(SESSION_ID);
    expect(detail.reference).toEqual({ agentName: "kimi-code", sessionId: SESSION_ID });
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Read package.json" }],
    });
    expect(detail.messages[1]).toMatchObject({
      role: "assistant",
      time_created: 1767225603000,
      parts: [
        { type: "reasoning", text: "Inspect the package manifest" },
        {
          type: "tool",
          tool: "ReadFile",
          title: "read",
          callID: "call-1",
          state: {
            status: "completed",
            input: { path: "package.json" },
            output: [{ type: "text", text: '{"name":"codesesh"}' }],
          },
        },
        { type: "text", text: "I found the package manifest." },
      ],
      tokens: { input: 13, output: 4, cache_read: 2, cache_create: 1 },
    });
    expect(detail.messages[2]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "The next step is separate." }],
    });
  });

  it("supports context messages written by migrated sessions", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    createSession(dataRoot, [
      { type: "metadata", protocol_version: "1.0", created_at: 1767225600000 },
      {
        type: "context.append_message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Inspect the file" },
            { type: "image_url", imageUrl: { url: "data:image/png;base64,abc" } },
          ],
        },
      },
      {
        type: "context.append_message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reading it." }],
          toolCalls: [
            {
              type: "function",
              id: "call-2",
              function: { name: "ReadFile", arguments: '{"path":"src/index.ts"}' },
            },
          ],
        },
      },
      {
        type: "context.append_message",
        message: {
          role: "tool",
          toolCallId: "call-2",
          content: [{ type: "text", text: "export const answer = 42;" }],
        },
      },
    ]);

    const agent = createAgent(dataRoot);
    agent.scan();
    const detail = agent.getSessionData(SESSION_ID);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Reading it." }),
      expect.objectContaining({
        type: "tool",
        tool: "ReadFile",
        state: expect.objectContaining({
          status: "completed",
          input: { path: "src/index.ts" },
          output: [expect.objectContaining({ type: "text", text: "export const answer = 42;" })],
        }),
      }),
    ]);
    expect(detail.messages[0]?.parts).toEqual([
      { type: "text", text: "Inspect the file", time_created: expect.any(Number) },
      {
        type: "image",
        url: "data:image/png;base64,abc",
        time_created: expect.any(Number),
      },
    ]);
  });

  it("does not expose empty sessions until their wire gains content", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    const emptyId = "ses_empty-kimi-code";
    const sessionDir = createSession(
      dataRoot,
      [{ type: "metadata", protocol_version: "1.4", created_at: 1767225600000 }],
      emptyId,
    );
    const agent = createAgent(dataRoot);

    expect(agent.scan()).toEqual([]);
    expect(agent.getSessionMetaMap().has(emptyId)).toBe(false);

    appendFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      `${JSON.stringify({
        type: "context.append_message",
        time: 1767225601000,
        message: { role: "user", content: [{ type: "text", text: "Continue" }] },
      })}\n`,
    );

    const refs = agent.listSessionSources();
    expect(agent.incrementalScan([], [emptyId], refs)).toMatchObject([
      { id: emptyId, stats: { message_count: 1 } },
    ]);
  });

  it("drops empty sessions restored from an older cache", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    createSession(dataRoot, [
      { type: "metadata", protocol_version: "1.4", created_at: 1767225600000 },
    ]);

    const agent = createAgent(dataRoot);
    const stale = {
      reference: { agentName: "kimi-code", sessionId: SESSION_ID },
      id: SESSION_ID,
      slug: `kimi-code/${SESSION_ID}`,
      title: "New Session",
      directory: WORK_DIR,
      time_created: 1767225600000,
      stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    };
    agent.setSessionMetaMap(
      new Map([[SESSION_ID, { id: SESSION_ID, sourcePath: join(dataRoot, "sessions") }]]),
    );

    expect(agent.filterCachedSessions([stale])).toEqual([]);
    expect(agent.getSessionMetaMap().has(SESSION_ID)).toBe(false);

    const changes = agent.checkForChanges(0, [stale]);
    expect(changes.hasChanges).toBe(true);
    expect(changes.changedIds).toContain(SESSION_ID);
    expect(agent.incrementalScan([stale], changes.changedIds ?? [], changes.refs)).toEqual([]);
  });

  it("keeps a missing record timestamp unavailable", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "codesesh-kimi-code-test-"));
    tempDirs.push(dataRoot);
    createSession(dataRoot, [
      { type: "metadata", protocol_version: "1.4", created_at: 1767225600000 },
      { type: "context.append_message", message: { role: "user", content: "No time" } },
    ]);

    const agent = createAgent(dataRoot);
    agent.scan();
    expect(agent.getSessionData(SESSION_ID).messages[0]?.time_created).toBe(0);
  });
});
