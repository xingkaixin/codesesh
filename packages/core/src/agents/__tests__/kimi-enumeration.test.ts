import { afterEach, describe, expect, it, vi } from "vitest";

// readFileSync is wrapped (call-through) so the suite can assert *which* files the
// enumeration path touches. Everything else stays real — the fixtures are real dirs.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
  mkdirSync,
  mkdtempSync,
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

function readPathsSince(callIndexFrom: number): string[] {
  return mockedReadFileSync.mock.calls
    .slice(callIndexFrom)
    .map(([path]) => String(path))
    .filter((path) => path.endsWith(".jsonl"));
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  mockedReadFileSync.mockClear();
});

describe("KimiAgent source enumeration", () => {
  it("does not read transcripts while enumerating sources", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "session-a", "Session A");
    createSessionDir(basePath, "session-b", "Session B");

    const agent = createAgent(basePath);
    const before = mockedReadFileSync.mock.calls.length;
    const refs = agent.listSessionSources();

    expect(refs.map((ref) => ref.sessionId).sort()).toEqual(["session-a", "session-b"]);
    expect(readPathsSince(before)).toEqual([]);
  });

  it("skips the transcript title fallback when state.json carries a title", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "titled", "Explicit title");

    const agent = createAgent(basePath);
    const sourcePath = join(basePath, PROJECT_HASH, "titled");
    const before = mockedReadFileSync.mock.calls.length;
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.title).toBe("Explicit title");
    expect(readPathsSince(before)).not.toContain(join(sourcePath, "context.jsonl"));
  });

  it("still falls back to the first user message when no explicit title exists", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    const sourcePath = createSessionDir(basePath, "untitled", "");

    const agent = createAgent(basePath);
    const head = agent.scanSessionSource(sourcePath);

    expect(head?.title).toBe("first message of untitled");
  });

  it("keeps the fingerprint bound to metadata and transcript mtimes only", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-enum-"));
    tempDirs.push(basePath);
    const sourcePath = createSessionDir(basePath, "fingerprint", "Fingerprint");

    // Pin the mtime so the rewrite below can restore it exactly — statSync
    // reports sub-millisecond precision that a Date round-trip would truncate.
    const contextPath = join(sourcePath, "context.jsonl");
    const pinned = new Date(1_700_000_000_000);
    utimesSync(contextPath, pinned, pinned);

    const agent = createAgent(basePath);
    const before = agent.listSessionSources()[0]?.fingerprint;

    // Rewriting the transcript body without moving its mtime must not move the
    // fingerprint: enumeration only observes mtimes, never content.
    writeFileSync(contextPath, JSON.stringify({ role: "user", content: "rewritten" }) + "\n");
    utimesSync(contextPath, pinned, pinned);

    expect(statSync(contextPath).mtimeMs).toBe(pinned.getTime());
    expect(agent.listSessionSources()[0]?.fingerprint).toBe(before);
  });
});
