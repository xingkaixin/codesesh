import {
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAgent } from "../codex.js";
import type { Message, MessagePart, SessionHead, ToolPart } from "../../types/index.js";
import { buildSessionTree } from "../../contract/session-tree.js";
import type { ModelPricing } from "../../pricing/fetcher.js";
import { pricingResolver } from "../../pricing/resolver.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

// Spies while delegating to the real implementation so regression tests can
// count filesystem calls during a live scan.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    id,
    slug: `codex/${id}`,
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

describe("CodexAgent cache refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("detects file set changes even when file count stays the same", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newC = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl",
    );

    writeFileSync(oldA, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n');
    writeFileSync(newC, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:05:00Z"}}\n');

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        { id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", sourcePath: oldA },
      ],
      [
        "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
        {
          id: "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
          sourcePath: join(tempDir, "missing.jsonl"),
        },
      ],
    ]);
    agent.listRolloutFiles = () => [
      { file: oldA, stat: statSync(oldA) },
      { file: newC, stat: statSync(newC) },
    ];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
      makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb");
  });

  it("re-prices a cached head after missing model pricing arrives", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const model = "vendor/codex-pricing-later";
    const pricing: ModelPricing = {
      inputCostPerToken: 0.001,
      outputCostPerToken: 0.002,
      cacheCreateCostPerToken: 0,
      cacheReadCostPerToken: 0,
      reasoningCostPerToken: 0,
      webSearchCostPerRequest: 0,
    };
    let pricingAvailable = false;
    const originalResolve = pricingResolver.resolve.bind(pricingResolver);
    vi.spyOn(pricingResolver, "resolve").mockImplementation((modelName) =>
      modelName === model ? (pricingAvailable ? pricing : null) : originalResolve(modelName),
    );
    writeFileSync(
      sessionFile,
      [
        `{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"${model}"}}`,
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20},"total_token_usage":{"total_tokens":120}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    const cached = agent.scan({ from: 0 }) as SessionHead[];
    expect(cached[0]?.stats.total_cost).toBe(0);
    expect(agent.getSessionCacheMeta(sessionId)?.unpricedModels).toEqual([model]);
    expect(agent.checkForChanges(Date.now(), cached).hasChanges).toBe(false);

    pricingAvailable = true;
    const changed = agent.checkForChanges(Date.now(), cached);
    expect(changed.changedIds).toEqual([sessionId]);

    const refreshed = agent.incrementalScan(cached, changed.changedIds ?? [], changed.refs);
    expect(refreshed[0]?.stats.total_cost).toBeGreaterThan(0);
    expect(agent.getSessionCacheMeta(sessionId)?.unpricedModels).toBeUndefined();
    expect(agent.checkForChanges(Date.now(), refreshed).hasChanges).toBe(false);
  });

  it("ignores unrelated session index changes during cache validation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const recentFile = join(sessionsDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const indexFile = join(codexHome, "session_index.jsonl");

    writeFileSync(
      recentFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"Old title"}\n`);

    const agent = new CodexAgent({ sourceRoot: sessionsDir }) as any;
    // Seed baseline meta with the live fingerprint.
    agent.scan();
    const baselineFingerprint = agent.listSessionSources()[0]?.fingerprint;

    // Append an unrelated index entry (mtime changes, but this session's
    // title is unchanged → its fingerprint must stay stable).
    const later = new Date(Date.now() + 2000);
    writeFileSync(
      indexFile,
      [
        `{"id":"${sessionId}","thread_name":"Old title"}`,
        '{"id":"019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb","thread_name":"Other title"}',
        "",
      ].join("\n"),
    );
    utimesSync(indexFile, later, later);

    const result = agent.checkForChanges(Date.now(), [
      makeSession(sessionId, { title: "Old title" }),
    ]);

    expect(result.hasChanges).toBe(false);
    expect(result.changedIds).toEqual([]);
    expect(agent.listSessionSources()[0]?.fingerprint).toBe(baselineFingerprint);
  });

  it("bounds listSessionSources to the mtime window when options are passed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const oldFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newFile = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb.jsonl",
    );
    writeFileSync(
      oldFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(
      newFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:05:00Z"}}\n',
    );

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newTime = new Date();
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    expect(
      agent
        .listSessionSources()
        .map((ref: { sourcePath: string }) => ref.sourcePath)
        .sort(),
    ).toEqual([oldFile, newFile].sort());

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref: { sourcePath: string }) => ref.sourcePath)).toEqual([newFile]);
  });

  it("stats each rollout file once during a scan", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);

    const sessionIds = [
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ];
    const files = sessionIds.map((id) => ({
      id,
      file: join(tempDir, `rollout-2026-04-20T10-00-00-${id}.jsonl`),
    }));
    for (const { id, file } of files) {
      writeFileSync(
        file,
        [
          JSON.stringify({
            timestamp: "2026-04-20T10:00:00Z",
            type: "session_meta",
            payload: { id, cwd: "/tmp/project" },
          }),
          JSON.stringify({
            timestamp: "2026-04-20T10:00:01Z",
            type: "response_item",
            payload: { type: "message", role: "user", content: `Inspect ${id}` },
          }),
          "",
        ].join("\n"),
      );
    }

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    const statSpy = vi.mocked(statSync);
    statSpy.mockClear();
    expect(agent.scan()).toHaveLength(files.length);

    for (const { file } of files) {
      const callsForFile = statSpy.mock.calls.filter((call) => call[0] === file);
      // One stat from the rollout listing, one from thread-meta fingerprinting;
      // the guard is against per-session rescans, i.e. O(files²) growth.
      expect(callsForFile.length).toBe(2);
    }
  });

  it("reuses cached thread meta when rebuilding the subagent index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const parentId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const otherParentId = "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb";
    const childId = "019dcccc-cccc-7ccc-cccc-cccccccccccc";
    const parentFile = join(tempDir, `rollout-2026-04-20T10-00-00-${parentId}.jsonl`);
    const otherParentFile = join(tempDir, `rollout-2026-04-20T10-01-00-${otherParentId}.jsonl`);
    const childFile = join(tempDir, `rollout-2026-04-20T10-05-00-${childId}.jsonl`);
    const meta = (payload: Record<string, unknown>) =>
      `${JSON.stringify({ type: "session_meta", payload })}\n`;
    writeFileSync(parentFile, meta({ id: parentId }));
    writeFileSync(otherParentFile, meta({ id: otherParentId }));
    writeFileSync(
      childFile,
      meta({ id: childId, thread_source: "subagent", parent_thread_id: parentId }),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    const window = { from: Date.now() - 24 * 60 * 60 * 1000 };
    const openSpy = vi.mocked(openSync);

    openSpy.mockClear();
    let sources = agent.listScanSources(window);
    expect(sources.map((ref: { file: string }) => ref.file).sort()).toEqual(
      [parentFile, otherParentFile, childFile].sort(),
    );
    expect(openSpy.mock.calls.length).toBe(3);

    // A new scan cycle drops the index but must rebuild it from cached meta.
    agent.restoreSessionCacheMeta({});
    openSpy.mockClear();
    sources = agent.listScanSources(window);
    expect(sources).toHaveLength(3);
    expect(openSpy.mock.calls.length).toBe(0);

    // A changed file invalidates only its own cache entry.
    writeFileSync(
      childFile,
      meta({ id: childId, thread_source: "subagent", parent_thread_id: otherParentId, v: 2 }),
    );
    agent.restoreSessionCacheMeta({});
    openSpy.mockClear();
    agent.listScanSources(window);
    expect(openSpy.mock.calls.length).toBe(1);
    expect(agent.ensureSubagentIndex().childFilesByParent.get(otherParentId)).toEqual([childFile]);
  });

  it("keeps source references and fingerprints byte-for-byte stable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-fingerprint-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(sessionsDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    writeFileSync(sessionFile, "fixture");
    writeFileSync(
      join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: sessionId, thread_name: "Indexed title" })}\n`,
    );

    const sessionTime = new Date(1_700_000_000_000);
    utimesSync(sessionFile, sessionTime, sessionTime);

    const agent = new CodexAgent({ sourceRoot: sessionsDir }) as any;

    expect(agent.listSessionSources()).toEqual([
      {
        sessionId,
        sourcePath: sessionFile,
        fingerprint: JSON.stringify([
          "codex-head-v2",
          "codex-parser-v8",
          sessionTime.getTime(),
          statSync(sessionFile).size,
          "Indexed title",
        ]),
      },
    ]);
  });

  it("caches an empty session index and reloads it when the mtime changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-empty-index-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    const indexFile = join(codexHome, "session_index.jsonl");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    writeFileSync(indexFile, "");

    for (const id of [
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ]) {
      writeFileSync(
        join(sessionsDir, `rollout-2026-04-20T10-00-00-${id}.jsonl`),
        '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
      );
    }

    const agent = new CodexAgent({ sourceRoot: sessionsDir }) as any;
    const readSpy = vi.mocked(readFileSync);
    const statSpy = vi.mocked(statSync);
    readSpy.mockClear();
    statSpy.mockClear();

    const initialFingerprint = agent.listSessionSources()[0]?.fingerprint;
    expect(agent.listSessionSources()[0]?.fingerprint).toBe(initialFingerprint);

    const later = new Date(Date.now() + 2000);
    writeFileSync(
      indexFile,
      '{"id":"019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa","thread_name":"Indexed title"}\n',
    );
    utimesSync(indexFile, later, later);
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(initialFingerprint);

    expect(readSpy.mock.calls.filter((call) => call[0] === indexFile)).toHaveLength(2);
    expect(statSpy.mock.calls.filter((call) => call[0] === indexFile)).toHaveLength(3);
  });

  it("uses per-session Codex titles in source fingerprints", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(sessionsDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const indexFile = join(codexHome, "session_index.jsonl");

    writeFileSync(
      sessionFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"Old title"}\n`);

    const firstAgent = new CodexAgent({ sourceRoot: sessionsDir }) as any;
    const firstFingerprint = firstAgent.listSessionSources()[0]?.fingerprint;

    writeFileSync(
      indexFile,
      [
        `{"id":"${sessionId}","thread_name":"Old title"}`,
        '{"id":"019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb","thread_name":"Other title"}',
        "",
      ].join("\n"),
    );
    const unrelatedAgent = new CodexAgent({ sourceRoot: sessionsDir }) as any;
    const unrelatedFingerprint = unrelatedAgent.listSessionSources()[0]?.fingerprint;

    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"New title"}\n`);
    const renamedAgent = new CodexAgent({ sourceRoot: sessionsDir }) as any;
    const renamedFingerprint = renamedAgent.listSessionSources()[0]?.fingerprint;

    expect(unrelatedFingerprint).toBe(firstFingerprint);
    expect(renamedFingerprint).not.toBe(firstFingerprint);
  });

  it("invalidates cached sessions when the parser version changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        {
          id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
          sourcePath: sessionFile,
          sourceMtimeMs: statSync(sessionFile).mtimeMs,
          indexPath: null,
          indexMtimeMs: null,
          headIndexVersion: "codex-head-v2",
          parserVersion: "codex-parser-v2",
        },
      ],
    ]);
    agent.listRolloutFiles = () => [{ file: sessionFile, stat: statSync(sessionFile) }];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
  });

  it("removes deleted sessions and adds new sessions during incremental scan", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newC = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl",
    );

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(oldA, "");
    writeFileSync(newC, "");

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    // Replace the single-file parser while keeping the shared scan lifecycle intact.
    agent.parseFileSessionHeadResult = (file: string) => {
      if (file === oldA) {
        return { status: "parsed", data: makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa") };
      }
      if (file === newC) {
        return { status: "parsed", data: makeSession("019dcccc-cccc-7ccc-cccc-cccccccccccc") };
      }
      return { status: "skipped", reason: "unknown fixture" };
    };

    const sessions = agent.incrementalScan(
      [
        makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
        makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
      ],
      ["019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb", "019dcccc-cccc-7ccc-cccc-cccccccccccc"],
    );

    expect(sessions.map((session: SessionHead) => session.id).sort()).toEqual([
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ]);
    expect(agent.sessionMetaMap.has("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb")).toBe(false);
  });

  it("uses the latest record timestamp as time_updated", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:02:30Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.time_created).toBe(new Date("2026-04-20T10:00:00Z").getTime());
    expect(head?.time_updated).toBe(new Date("2026-04-20T10:02:30Z").getTime());
  });

  it("preserves explicit timezone offsets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00+08:00","type":"session_meta","payload":{"cwd":"/tmp/project"}}',
        '{"timestamp":"2026-04-20T10:02:30+08:00","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();
    const head = agent.scanSessionSource(sessionFile);

    expect(head?.time_created).toBe(Date.parse("2026-04-20T10:00:00+08:00"));
    expect(head?.time_updated).toBe(Date.parse("2026-04-20T10:02:30+08:00"));
  });

  it("aggregates model usage from token count events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5},"total_token_usage":{"total_tokens":125}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(100);
    expect(head?.stats.total_output_tokens).toBe(25);
    expect(head?.stats.total_cost).toBe(0.00125);
    expect(head?.stats.cost_source).toBe("estimated");
    expect(head?.model_usage).toEqual({ "gpt-5.5": 125 });
  });

  it("uses the session metadata model while parsing details", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20},"total_token_usage":{"total_tokens":120}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    const [head] = agent.scan();
    const detail = agent.getSessionData(sessionId);

    expect(detail.messages[0]?.model).toBe("gpt-5.5");
    expect(detail.stats.total_cost).toBe(head?.stats.total_cost);
    expect(detail.stats.total_cost).toBeGreaterThan(0);
  });

  it("keeps head and detail token stats aligned without cumulative usage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaab";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    const [head] = agent.scan();
    const detail = agent.getSessionData(sessionId);

    expect(detail.stats).toMatchObject({
      total_input_tokens: head?.stats.total_input_tokens,
      total_output_tokens: head?.stats.total_output_tokens,
      total_cache_read_tokens: head?.stats.total_cache_read_tokens,
      total_cost: head?.stats.total_cost,
    });
  });

  it("prices Codex cached input with cache read rates", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":20},"total_token_usage":{"total_tokens":1020}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(1000);
    expect(head?.stats.total_cache_read_tokens).toBe(800);
    expect(head?.stats.total_output_tokens).toBe(20);
    expect(head?.stats.total_cost).toBe(0.002);
    expect(head?.model_usage).toEqual({ "gpt-5.5": 1020 });
  });

  it("updates model usage when the active Codex model changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20},"total_token_usage":{"total_tokens":120}}}}',
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","model":"gpt-5.4","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:03:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":40,"output_tokens":10},"total_token_usage":{"total_tokens":170}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.model_usage).toEqual({ "gpt-5.5": 120, "gpt-5.4": 50 });
  });

  it("falls back to untitled when no title source is available", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.title).toBe("Untitled Session");
  });

  it("filters internal-only sessions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"progress","payload":{"type":"progress"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    expect(agent.scan()).toEqual([]);
  });

  it("cleans internal tag blocks from messages and tool output", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>noise</environment_context>" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content:
              "Visible request\n<command-name>clear</command-name>\n<local-command-stdout>noise</local-command-stdout>",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Visible answer <system-reminder>hidden</system-reminder>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:04Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:05Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Visible output\n<local-command-stdout>/tmp/project</local-command-stdout>",
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(head?.title).toBe("Visible request");
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Visible answer",
    });
    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        output: [expect.objectContaining({ type: "text", text: "Visible output" })],
      },
    });
  });

  it("normalizes namespaced MCP function calls for display", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019da000-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "List labels" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Checking Linear" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-linear",
            name: "_list_issue_labels",
            namespace: "mcp__codex_apps__linear",
            arguments: '{"team":"research&develop"}',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "linear.list_issue_labels",
      title: "Tool: linear.list_issue_labels",
      state: {
        input: { team: "research&develop" },
        metadata: {
          name: "_list_issue_labels",
          namespace: "mcp__codex_apps__linear",
        },
      },
    });
  });

  it("uses the tool name when the MCP namespace has no display segment", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019da001-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-node",
            name: "js",
            namespace: "mcp__node_repl__",
            arguments: '{"code":"1 + 1"}',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[0]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "js",
      title: "Tool: js",
      state: {
        input: { code: "1 + 1" },
        metadata: {
          name: "js",
          namespace: "mcp__node_repl__",
        },
      },
    });
  });

  it("parses messages, plans, tools, outputs, and token usage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const patchInput = [
      "*** Begin Patch",
      "*** Add File: package.json",
      '+{ "name": "codesesh" }',
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "-old",
      "+new",
      "*** Delete File: old.ts",
      "*** End Patch",
    ].join("\n");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project", model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "turn_context",
          payload: { model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>noise</environment_context>" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Implement parser coverage" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:04Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Plan ready\n<proposed_plan>\n1. Add tests\n</proposed_plan>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:05Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "PLEASE IMPLEMENT THIS PLAN",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:06Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need file context" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:07Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Reading files" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:08Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"ls"}',
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:09Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "package.json",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:10Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call-2",
            name: "apply_patch",
            input: patchInput,
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:11Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-2",
            output: "Success",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:12Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                cached_input_tokens: 10,
              },
              total_token_usage: { total_tokens: 125 },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:13Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content:
              '<subagent_notification>{"agent_id":"agent-1","nickname":"worker","completed":"done"}</subagent_notification>',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const assistantWithTools = data.messages.find((message: Message) =>
      message.parts.some((part: MessagePart) => part.type === "tool" && part.tool === "bash"),
    );
    const bashPart = assistantWithTools?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "bash",
    );
    const patchPart = assistantWithTools?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "patch",
    );

    expect(head).toMatchObject({
      id: sessionId,
      title: "Implement parser coverage",
      directory: "/tmp/project",
      stats: {
        message_count: 8,
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_cache_read_tokens: 10,
      },
      model_usage: { "gpt-5.5": 125 },
    });
    expect(data.messages.map((message: Message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(data.messages[1]?.parts).toContainEqual(
      expect.objectContaining({ type: "plan", text: "1. Add tests" }),
    );
    expect(data.messages[3]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need file context",
    });
    expect(bashPart).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        input: { cmd: "ls" },
        output: [{ type: "text", text: "package.json" }],
        status: "completed",
      },
    });
    expect(patchPart).toMatchObject({
      type: "tool",
      tool: "patch",
      state: {
        input: [
          { type: "write_file", path: "package.json" },
          { type: "move_file", path: "src/a.ts", targetPath: "src/b.ts" },
          { type: "delete_file", path: "old.ts" },
        ],
        output: [{ type: "text", text: "Success" }],
        status: "completed",
      },
    });
    expect(assistantWithTools).toMatchObject({
      tokens: { input: 100, output: 20, reasoning: 5, cache_read: 10 },
      cost_source: "estimated",
    });
    expect(data.messages[4]).toMatchObject({
      role: "assistant",
      subagent_id: "agent-1",
      nickname: "worker",
      parts: [{ type: "text", text: "done" }],
    });
  });
});

describe("CodexAgent code-mode exec decoding", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function writeCodeModeSession(records: Record<string, unknown>[]): {
    agent: any;
    sessionId: string;
  } {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-codemode-"));
    tempDirs.push(tempDir);
    const sessionId = "019dcode-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-07-19T10-00-00-${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({
        timestamp: "2026-07-19T10:00:00Z",
        type: "session_meta",
        payload: { cwd: "/tmp/project", cli_version: "0.144.0-alpha.4" },
      }),
      ...records.map((record) => JSON.stringify({ timestamp: "2026-07-19T10:00:01Z", ...record })),
      "",
    ];
    writeFileSync(sessionFile, lines.join("\n"));

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.scan();
    return { agent, sessionId };
  }

  function firstToolPart(agent: any, sessionId: string): MessagePart | undefined {
    const data = agent.getSessionData(sessionId);
    for (const message of data.messages) {
      const part = message.parts.find((candidate: MessagePart) => candidate.type === "tool");
      if (part) return part;
    }
    return undefined;
  }

  it("decodes exec_command into a bash tool with stripped output", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "exec",
          input:
            'const r = await tools.exec_command({cmd:"ls",workdir:"/tmp/project"}); text(r.output)',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "package.json" },
          ],
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        input: { cmd: "ls", workdir: "/tmp/project" },
        output: [{ type: "text", text: "package.json" }],
        status: "completed",
      },
    });
  });

  it("decodes apply_patch into a patch tool with parsed blocks", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-2",
          name: "exec",
          input:
            'const patch = "*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch";\nconst r = await tools.apply_patch({patch}); text(r.output)',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
            { type: "input_text", text: "Success" },
          ],
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "patch",
      state: {
        input: [{ type: "write_file", path: "a.txt", content: "+hello" }],
        output: [{ type: "text", text: "Success" }],
        status: "completed",
      },
    });
  });

  it("decodes a namespaced node_repl js call", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-3",
          name: "exec",
          input:
            'const r = await tools.mcp__node_repl__js({title:"Check state",code:"1+1"}); text(r)',
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "js",
      title: "Tool: js",
      state: {
        input: { title: "Check state", code: "1+1" },
        metadata: { name: "js", namespace: "mcp__node_repl__" },
      },
    });
  });

  it("decodes write_stdin", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-4",
          name: "exec",
          input:
            'const r = await tools.write_stdin({session_id:68920,chars:"yes"}); text(r.output)',
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "write_stdin",
      state: { input: { session_id: 68920, chars: "yes" } },
    });
  });

  it("splits a multi-call program into ordered tool parts", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-5",
          name: "exec",
          input:
            'let r = await tools.exec_command({cmd:"ls"}); text(r.output); const patch = "*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"; await tools.apply_patch({patch})',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-5",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "a.txt" },
          ],
        },
      },
    ]);

    const data = agent.getSessionData(sessionId);
    const toolParts = (data.messages as Message[])
      .flatMap((message) => message.parts)
      .filter((partValue): partValue is ToolPart => partValue.type === "tool");

    expect(toolParts.map((partValue) => partValue.tool)).toEqual(["bash", "patch"]);
    // The combined output routes to the output-bearing bash part, not the patch.
    expect(toolParts[0]).toMatchObject({
      tool: "bash",
      state: { output: [{ type: "text", text: "a.txt" }], status: "completed" },
    });
    expect(toolParts[1]).toMatchObject({
      tool: "patch",
      state: { input: [{ type: "write_file", path: "a.txt", content: "+hi" }], output: null },
    });
  });
});

describe("CodexAgent field shape mismatches", () => {
  let diagnosticsCalls: Array<{ event: string; detail?: Record<string, unknown> }>;

  afterEach(() => {
    setCoreDiagnostics(null);
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function captureDiagnostics(): void {
    diagnosticsCalls = [];
    const sink: CoreDiagnostics = {
      warn: (event, detail) => diagnosticsCalls.push({ event, detail }),
    };
    setCoreDiagnostics(sink);
  }

  it("falls back to zeroed tokens and reports a mismatch when token_count.info drifts", () => {
    captureDiagnostics();
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        // "info" has drifted from an object to a string upstream.
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":"unexpected-string"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.scanSessionSource(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(0);
    expect(head?.stats.total_output_tokens).toBe(0);
    expect(head?.model_usage).toBeUndefined();
    expect(diagnosticsCalls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "codex", field: "token_count.info" },
    });
  });

  it("skips a response_item and reports a mismatch when payload drifts to a non-object", () => {
    captureDiagnostics();
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-bbbbbbbbbbbb";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project"}}',
        // "payload" has drifted from an object to a bare string upstream.
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":"unexpected-string"}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.scan();

    const data = agent.getSessionData(sessionId);

    expect(data.messages).toEqual([]);
    expect(diagnosticsCalls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "codex", field: "payload" },
    });
  });
});

describe("CodexAgent subagent folding", () => {
  const PARENT_ID = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
  const CHILD_ID = "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb";

  function writeSession(
    dir: string,
    id: string,
    lines: {
      threadSource: string;
      parentThreadId?: string | null;
      agentNickname?: string;
      extra?: string[];
    },
  ) {
    const meta = {
      session_id: lines.parentThreadId ?? id,
      id,
      thread_source: lines.threadSource,
      ...(lines.parentThreadId ? { parent_thread_id: lines.parentThreadId } : {}),
      ...(lines.agentNickname ? { agent_nickname: lines.agentNickname } : {}),
    };
    const content = [
      `{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":${JSON.stringify({ cwd: "/tmp/project", ...meta })}}`,
      ...(lines.extra ?? []),
      "",
    ].join("\n");
    writeFileSync(join(dir, `rollout-2026-04-20T10-00-00-${id}.jsonl`), content);
  }

  function tokenCountLine(input: number, output: number, total: number) {
    return `{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":${input},"output_tokens":${output}},"total_token_usage":{"total_tokens":${total}}}}}`;
  }

  function makeMessage(options: {
    subagentId?: string;
    nickname?: string;
    texts: string[];
  }): Message {
    return {
      id: `message-${options.texts.join("-")}`,
      role: "assistant",
      agent: "codex",
      time_created: 0,
      mode: null,
      model: null,
      provider: null,
      cost: 0,
      ...(options.subagentId === undefined ? {} : { subagent_id: options.subagentId }),
      ...(options.nickname === undefined ? {} : { nickname: options.nickname }),
      parts: options.texts.map((text) => ({ type: "text", text, time_created: 0 })),
    };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("returns subagent files with node-local head stats", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, {
      threadSource: "user",
      extra: [
        tokenCountLine(100, 20, 120),
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      ],
    });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [tokenCountLine(40, 60, 100)],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();

    const heads = agent.scan({ from: 0 });
    expect(heads.map((h: SessionHead) => h.id)).toEqual([PARENT_ID, CHILD_ID]);
    expect(heads[0].stats.total_input_tokens).toBe(100);
    expect(heads[0].stats.total_output_tokens).toBe(20);
    expect(heads[1].parent_reference).toEqual({ agentName: "codex", sessionId: PARENT_ID });
    expect(heads[1].stats.total_input_tokens).toBe(40);
    expect(buildSessionTree(heads).roots[0]?.inclusiveStats).toMatchObject({
      inputTokens: 140,
      outputTokens: 80,
    });
  });

  it("folds subagent tokens into getSessionData detail stats", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, {
      threadSource: "user",
      extra: [
        tokenCountLine(100, 20, 120),
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      ],
    });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [tokenCountLine(40, 60, 100)],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    agent.scan({ from: 0 });

    const data = agent.getSessionData(PARENT_ID);
    expect(data.stats.total_input_tokens).toBe(140);
    expect(data.stats.total_output_tokens).toBe(80);
    expect(data.messages.every((m: Message) => m.parts.length >= 0)).toBe(true);
  });

  it("loads the final assistant output from a child rollout", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, {
      threadSource: "user",
      extra: [
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"parent done"}]}}',
      ],
    });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      agentNickname: "worker",
      extra: [
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","phase":"commentary","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"working"}]}}',
        '{"timestamp":"2026-04-20T10:03:00Z","type":"response_item","payload":{"type":"message","id":"child-final","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"child result"}]}}',
      ],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    agent.scan({ from: 0 });

    const data = agent.getSessionData(PARENT_ID);
    expect(data.messages).toContainEqual(
      expect.objectContaining({
        id: "child-final",
        role: "assistant",
        subagent_id: CHILD_ID,
        nickname: "worker",
        parts: [{ type: "text", text: "child result", time_created: expect.any(Number) }],
      }),
    );
    expect(
      data.messages.some((message: Message) =>
        message.parts.some((part: MessagePart) => part.type === "text" && part.text === "working"),
      ),
    ).toBe(false);
    expect(data.stats.message_count).toBe(data.messages.length);
  });

  it("merges child messages with exact id and nickname/text visibility rules", () => {
    const agent = new CodexAgent() as any;
    const visibleMessages = [
      makeMessage({ subagentId: "known-child", nickname: "worker", texts: ["id match"] }),
      makeMessage({ nickname: "worker", texts: ["prefix", "shared text"] }),
    ];

    agent.mergeChildMessages(visibleMessages, [
      makeMessage({ subagentId: "known-child", nickname: "other", texts: ["different"] }),
      makeMessage({ nickname: "worker", texts: ["shared text"] }),
      makeMessage({ subagentId: "different-child", nickname: "worker", texts: ["shared text"] }),
      makeMessage({ nickname: "worker", texts: ["different text"] }),
    ]);

    expect(
      visibleMessages.map((message) => {
        const part = message.parts[0];
        return part?.type === "text" ? part.text : undefined;
      }),
    ).toEqual(["id match", "prefix", "different text"]);

    const identifiedVisible = [
      makeMessage({ subagentId: "identified", nickname: "worker", texts: ["shared text"] }),
    ];
    agent.mergeChildMessages(identifiedVisible, [
      makeMessage({ nickname: "worker", texts: ["shared text"] }),
    ]);
    expect(identifiedVisible).toHaveLength(2);

    const newlyVisible: Message[] = [];
    agent.mergeChildMessages(newlyVisible, [
      makeMessage({ nickname: "worker", texts: ["new text"] }),
      makeMessage({ nickname: "worker", texts: ["new text"] }),
    ]);
    expect(newlyVisible).toHaveLength(1);
  });

  it("merges large child batches without pairwise array scans", () => {
    const agent = new CodexAgent() as any;
    const visibleMessages = Array.from({ length: 200 }, (_, index) =>
      makeMessage({ nickname: `worker-${index}`, texts: [`visible-${index}`] }),
    );
    const childMessages = Array.from({ length: 200 }, (_, index) =>
      makeMessage({ nickname: `child-${index}`, texts: [`child-${index}`] }),
    );
    const someSpy = vi.spyOn(Array.prototype, "some");

    someSpy.mockClear();
    agent.mergeChildMessages(visibleMessages, childMessages);
    const someCallCount = someSpy.mock.calls.length;
    someSpy.mockRestore();

    expect(someCallCount).toBe(0);
    expect(visibleMessages).toHaveLength(400);
  });

  function childOpenCount(filePath: string): number {
    return vi.mocked(openSync).mock.calls.filter(([path]) => String(path) === filePath).length;
  }

  it("caches child final messages until the source or parser changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);
    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [
        '{"timestamp":"2026-04-20T10:03:00Z","type":"response_item","phase":"final_answer","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first child result"}]}}',
      ],
    });
    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    agent.scan({ from: 0 });
    agent.getSessionData(PARENT_ID);

    const openSpy = vi.mocked(openSync);
    openSpy.mockClear();
    agent.getSessionData(PARENT_ID);
    expect(childOpenCount(childFile)).toBe(0);

    const cacheEntry = agent.childFinalMessagesByParent.get(PARENT_ID)?.get(childFile);
    expect(cacheEntry).toBeDefined();
    cacheEntry.parserVersion = "codex-parser-old";
    openSpy.mockClear();
    agent.getSessionData(PARENT_ID);
    expect(childOpenCount(childFile)).toBeGreaterThan(0);

    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [
        '{"timestamp":"2026-04-20T10:03:00Z","type":"response_item","phase":"final_answer","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"updated child result"}]}}',
      ],
    });
    openSpy.mockClear();
    const refreshed = agent.getSessionData(PARENT_ID);
    expect(childOpenCount(childFile)).toBeGreaterThan(0);
    expect(refreshed.messages).toContainEqual(
      expect.objectContaining({
        parts: [expect.objectContaining({ type: "text", text: "updated child result" })],
      }),
    );
  });

  it("caches a child with no final message", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);
    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
    });
    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    agent.scan({ from: 0 });
    expect(agent.getSessionData(PARENT_ID).messages).toEqual([]);

    vi.mocked(openSync).mockClear();
    expect(agent.getSessionData(PARENT_ID).messages).toEqual([]);
    expect(childOpenCount(childFile)).toBe(0);
  });

  it("prunes child final message cache entries when a child disappears", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);
    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [
        '{"timestamp":"2026-04-20T10:03:00Z","type":"response_item","phase":"final_answer","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"child result"}]}}',
      ],
    });
    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    agent.scan({ from: 0 });
    agent.getSessionData(PARENT_ID);
    expect(agent.childFinalMessagesByParent.get(PARENT_ID)?.has(childFile)).toBe(true);

    rmSync(childFile);
    agent.subagentIndex = null;
    agent.getSessionData(PARENT_ID);
    expect(agent.childFinalMessagesByParent.has(PARENT_ID)).toBe(false);
  });

  it("finds child rollouts when detail parsing starts from cached metadata", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      agentNickname: "worker",
      extra: [
        '{"timestamp":"2026-04-20T10:03:00Z","type":"response_item","phase":"final_answer","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"cached child result"}]}}',
      ],
    });

    const scanned = new CodexAgent({ sourceRoot: tempDir }) as any;
    scanned.sessionIndexCache = new Map();
    scanned.scan({ from: 0 });

    const fresh = new CodexAgent() as any;
    fresh.findBasePath = () => tempDir;
    fresh.restoreSessionCacheMeta(scanned.snapshotSessionCacheMeta());

    const data = fresh.getSessionData(PARENT_ID);
    expect(data.messages).toContainEqual(
      expect.objectContaining({
        subagent_id: CHILD_ID,
        parts: [expect.objectContaining({ type: "text", text: "cached child result" })],
      }),
    );
  });

  it("leaves a session without children unchanged", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, {
      threadSource: "user",
      extra: [
        tokenCountLine(100, 20, 120),
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      ],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();

    const [head] = agent.scan({ from: 0 });
    expect(head.id).toBe(PARENT_ID);
    expect(head.stats.total_input_tokens).toBe(100);
    expect(head.stats.total_output_tokens).toBe(20);
  });

  it("expands a changed child to include its parent, leaving roots alone", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();

    const refs = [
      {
        sessionId: PARENT_ID,
        sourcePath: join(tempDir, `rollout-2026-04-20T10-00-00-${PARENT_ID}.jsonl`),
        fingerprint: "p",
      },
      {
        sessionId: CHILD_ID,
        sourcePath: join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`),
        fingerprint: "c",
      },
    ];
    expect(agent.expandChangedSessionIds([CHILD_ID], refs).slice().sort()).toEqual(
      [CHILD_ID, PARENT_ID].slice().sort(),
    );
    expect(agent.expandChangedSessionIds([PARENT_ID], refs)).toEqual([PARENT_ID]);
  });

  it("expands a removed child via cached metadata to refresh the parent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, {
      threadSource: "user",
      extra: [tokenCountLine(100, 20, 120)],
    });
    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [tokenCountLine(40, 60, 100)],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();
    const [parentHead] = agent.scan({ from: 0 });
    expect(parentHead.stats.total_input_tokens).toBe(100);

    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);
    rmSync(childFile);
    expect(agent.expandChangedSessionIds([CHILD_ID]).slice().sort()).toEqual(
      [CHILD_ID, PARENT_ID].slice().sort(),
    );

    const parentFile = join(tempDir, `rollout-2026-04-20T10-00-00-${PARENT_ID}.jsonl`);
    expect(agent.scanSessionSource(parentFile)?.stats.total_input_tokens).toBe(100);
  });

  it("parses subagent files via scanSessionSource", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, CHILD_ID, {
      threadSource: "subagent",
      parentThreadId: PARENT_ID,
      extra: [tokenCountLine(40, 60, 100)],
    });

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();

    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);
    expect(agent.scanSessionSource(childFile)).toMatchObject({
      id: CHILD_ID,
      parent_reference: { agentName: "codex", sessionId: PARENT_ID },
    });
  });

  it("parses oversized subagent metadata in fast scans", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-subagent-"));
    tempDirs.push(tempDir);

    writeSession(tempDir, PARENT_ID, { threadSource: "user" });
    const childFile = join(tempDir, `rollout-2026-04-20T10-00-00-${CHILD_ID}.jsonl`);
    writeFileSync(
      childFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: {
            cwd: "/tmp/project",
            thread_source: "subagent",
            parent_thread_id: PARENT_ID,
            instructions: "x".repeat(70 * 1024),
          },
        }),
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"child done"}]}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent({ sourceRoot: tempDir }) as any;
    agent.sessionIndexCache = new Map();

    const heads = agent.scan({ from: 0, fast: true });
    expect(heads.find((head: SessionHead) => head.id === CHILD_ID)).toMatchObject({
      parent_reference: { agentName: "codex", sessionId: PARENT_ID },
    });
  });
});
