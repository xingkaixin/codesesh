import { afterEach, describe, expect, it, vi } from "vitest";

// Both file-read entry points are wrapped (call-through) so the suite can assert
// *which* files a code path opens: readFileSync for whole-file loads, openSync for
// the streaming reader. Everything else stays real — the fixtures are real dirs.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
  };
});

import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAgent } from "../kimi.js";

const PROJECT_HASH = "project-hash";
const PROJECT_DIR = "/tmp/kimi-project";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedOpenSync = vi.mocked(openSync);

let tempDirs: string[] = [];

function createAgent(basePath: string): KimiAgent {
  const agent = new KimiAgent() as never as {
    basePath: string;
    projectMap: Map<string, string>;
  };
  agent.basePath = basePath;
  agent.projectMap = new Map([[PROJECT_HASH, PROJECT_DIR]]);
  return agent as never as KimiAgent;
}

function createSessionDir(basePath: string, id: string, customTitle: string): string {
  const sessionDir = join(basePath, PROJECT_HASH, id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "state.json"),
    JSON.stringify({ custom_title: customTitle, wire_mtime: 1_000 }),
  );
  writeFileSync(
    join(sessionDir, "context.jsonl"),
    JSON.stringify({ role: "user", content: `first message of ${id}` }) + "\n",
  );
  return sessionDir;
}

/** Every `.jsonl` path opened for reading since the counters were snapshotted. */
function transcriptReadsSince(marks: { read: number; open: number }): string[] {
  return [
    ...mockedReadFileSync.mock.calls.slice(marks.read),
    ...mockedOpenSync.mock.calls.slice(marks.open),
  ]
    .map(([path]) => String(path))
    .filter((path) => path.endsWith(".jsonl"));
}

function markReads(): { read: number; open: number } {
  return {
    read: mockedReadFileSync.mock.calls.length,
    open: mockedOpenSync.mock.calls.length,
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  mockedReadFileSync.mockClear();
  mockedOpenSync.mockClear();
});

describe("KimiAgent source enumeration", () => {
  it("does not read transcripts while enumerating sources", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "session-a", "Session A");
    createSessionDir(basePath, "session-b", "Session B");

    const agent = createAgent(basePath);
    const marks = markReads();
    const refs = agent.listSessionSources();

    expect(refs.map((ref) => ref.sessionId).sort()).toEqual(["session-a", "session-b"]);
    expect(transcriptReadsSince(marks)).toEqual([]);
  });

  it("reads context once for stats when state.json carries a title", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "titled", "Explicit title");

    const agent = createAgent(basePath);
    const sourcePath = join(basePath, PROJECT_HASH, "titled");
    const marks = markReads();
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.title).toBe("Explicit title");
    expect(transcriptReadsSince(marks)).toEqual([join(sourcePath, "context.jsonl")]);
  });

  it("still falls back to the first user message when no explicit title exists", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    const sourcePath = createSessionDir(basePath, "untitled", "");

    const agent = createAgent(basePath);
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.title).toBe("first message of untitled");
  });

  it("fingerprints the parser revision, metadata, and transcript snapshots", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    const sourcePath = createSessionDir(basePath, "fingerprint", "Fingerprint");

    // Pin the mtime so the rewrite below can restore it exactly — statSync
    // reports sub-millisecond precision that a Date round-trip would truncate.
    const statePath = join(sourcePath, "state.json");
    const contextPath = join(sourcePath, "context.jsonl");
    const stateTime = new Date(1_699_999_999_000);
    const pinned = new Date(1_700_000_000_000);
    utimesSync(statePath, stateTime, stateTime);
    utimesSync(contextPath, pinned, pinned);

    const agent = createAgent(basePath);
    const [before] = agent.listSessionSources();
    expect(before).toEqual({
      sessionId: "fingerprint",
      sourcePath,
      fingerprint: JSON.stringify([
        "kimi-parser-v1",
        stateTime.getTime(),
        statSync(statePath).size,
        pinned.getTime(),
        statSync(contextPath).size,
        null,
        null,
      ]),
    });

    writeFileSync(
      contextPath,
      JSON.stringify({ role: "user", content: "a longer rewritten message" }) + "\n",
    );
    utimesSync(contextPath, pinned, pinned);

    expect(statSync(contextPath).mtimeMs).toBe(pinned.getTime());
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(before?.fingerprint);
  });
});

describe("KimiAgent stats extraction", () => {
  function createWireOnlySession(basePath: string, id: string, title: string): string {
    const sessionDir = join(basePath, PROJECT_HASH, id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ custom_title: title, wire_mtime: 1_000 }),
    );
    writeFileSync(
      join(sessionDir, "wire.jsonl"),
      [
        JSON.stringify({
          timestamp: 1,
          message: {
            type: "ContentPart",
            payload: { type: "text", text: "hi" },
            usage: { input_tokens: 12, output_tokens: 5 },
          },
        }),
        JSON.stringify({ role: "_usage", token_count: 999 }),
        "",
      ].join("\n"),
    );
    return sessionDir;
  }

  it("walks wire.jsonl once when there is no context.jsonl", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-stats-"));
    tempDirs.push(basePath);
    const sourcePath = createWireOnlySession(basePath, "wire-only", "Wire only");

    const agent = createAgent(basePath);
    const marks = markReads();
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.stats).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 5,
      total_tokens: 999,
    });
    expect(transcriptReadsSince(marks)).toEqual([join(sourcePath, "wire.jsonl")]);
  });

  it("reads each transcript once while materializing a context detail", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-stats-"));
    tempDirs.push(basePath);
    const sourcePath = createWireOnlySession(basePath, "detail-reads", "Detail reads");
    writeFileSync(
      join(sourcePath, "context.jsonl"),
      [
        JSON.stringify({ role: "user", content: "Context message" }),
        JSON.stringify({ role: "_usage", token_count: 42 }),
        "",
      ].join("\n"),
    );

    const agent = createAgent(basePath);
    (agent as unknown as { defaultModel: string | null }).defaultModel = "kimi-for-coding";
    const [head] = agent.scan();
    const marks = markReads();
    const detail = agent.getSessionData("detail-reads");

    expect(detail.stats).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 5,
      total_tokens: 42,
      total_cost: 0.0000197,
      cost_source: "estimated",
    });
    expect(head?.stats).toMatchObject({
      total_input_tokens: detail.stats.total_input_tokens,
      total_output_tokens: detail.stats.total_output_tokens,
      total_tokens: detail.stats.total_tokens,
      total_cost: detail.stats.total_cost,
      cost_source: detail.stats.cost_source,
    });
    expect(transcriptReadsSince(marks)).toEqual([
      join(sourcePath, "context.jsonl"),
      join(sourcePath, "wire.jsonl"),
    ]);
  });

  it("reads wire once while materializing a wire-only detail", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-stats-"));
    tempDirs.push(basePath);
    const sourcePath = createWireOnlySession(basePath, "wire-detail", "Wire detail");

    const agent = createAgent(basePath);
    agent.scan();
    const marks = markReads();
    const detail = agent.getSessionData("wire-detail");

    expect(detail.stats).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 5,
      total_tokens: 999,
    });
    expect(transcriptReadsSince(marks)).toEqual([join(sourcePath, "wire.jsonl")]);
  });

  it("reads the usage total from context.jsonl when it exists", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-stats-"));
    tempDirs.push(basePath);
    const sourcePath = createWireOnlySession(basePath, "with-context", "With context");
    writeFileSync(
      join(sourcePath, "context.jsonl"),
      JSON.stringify({ role: "_usage", token_count: 42 }) + "\n",
    );

    const agent = createAgent(basePath);
    const head = agent.scanSessionSource(sourcePath);

    // context.jsonl wins over the _usage record sitting in wire.jsonl.
    expect(head?.stats).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 5,
      total_tokens: 42,
    });
  });

  it("reads usage totals from a context-only session", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-stats-"));
    tempDirs.push(basePath);
    const sourcePath = createSessionDir(basePath, "context-only", "Context only");
    writeFileSync(
      join(sourcePath, "context.jsonl"),
      JSON.stringify({ role: "_usage", token_count: 42 }) + "\n",
    );

    const agent = createAgent(basePath);
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.stats.total_tokens).toBe(42);
  });
});
