import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorAgent } from "../cursor.js";
import { SessionScanError } from "../base.js";
import type { ModelPricing } from "../../pricing/fetcher.js";
import { pricingResolver } from "../../pricing/resolver.js";
import type { MessagePart } from "../../types/index.js";
import {
  getCoreDiagnostics,
  setCoreDiagnostics,
  type CoreDiagnostics,
} from "../../utils/diagnostics.js";

let tempDirs: string[] = [];

const CURSOR_FIXTURE_ROOT = new URL("./fixtures/cursor/", import.meta.url);

function createCursorDb(tempDir: string): string {
  const dbPath = join(tempDir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.close();
  return dbPath;
}

function insertKv(dbPath: string, key: string, value: unknown): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  db.close();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("CursorAgent parsing", () => {
  it("ignores workspace metadata in a linked workspace directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dataRoot = join(tempDir, "cursor");
    const workspaceStorage = join(dataRoot, "workspaceStorage");
    const outsideWorkspace = join(tempDir, "outside-workspace");
    mkdirSync(workspaceStorage, { recursive: true });
    mkdirSync(outsideWorkspace);
    writeFileSync(
      join(outsideWorkspace, "workspace.json"),
      JSON.stringify({ folder: "file:///outside/project" }),
    );
    const db = new Database(join(outsideWorkspace, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "outside-composer" }] }),
    );
    db.close();
    symlinkSync(outsideWorkspace, join(workspaceStorage, "linked-workspace"));
    vi.stubEnv("CURSOR_DATA_PATH", dataRoot);

    const map = (new CursorAgent() as any).buildWorkspacePathMap();

    expect(map).toEqual(new Map());
  });

  it("cleans internal tags and keeps normalized tool names", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:user", {
      type: 1,
      text: "Visible request\n<command-name>clear</command-name>",
      createdAt: 1_000,
    });
    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Visible answer <system-reminder>hidden</system-reminder>",
      createdAt: 2_000,
      toolFormerData: {
        name: "run_terminal_command_v2",
        toolCallId: "call-1",
        status: "completed",
        result: "Visible output\n<local-command-stdout>noise</local-command-stdout>",
      },
    });

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", {
      id: "composer-1",
      text: "Fallback title",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const data = agent.getSessionData("composer-1");
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(data.title).toBe("Visible request");
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
        output: "Visible output",
      },
    });
  });

  it("keeps completed tools successful when output contains message or stderr", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      createdAt: 1_000,
      toolFormerData: {
        name: "run_terminal_command_v2",
        status: "completed",
        result: JSON.stringify({ message: "Command finished", stderr: "npm progress" }),
      },
    });

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", { id: "composer-1", createdAt: 1_000 });

    const tool = agent
      .getSessionData("composer-1")
      .messages[0]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(tool).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        output: { message: "Command finished", stderr: "npm progress" },
      },
    });
    expect(tool?.type === "tool" ? tool.state.error : undefined).toBeUndefined();
  });

  it("normalizes array tool output from subagent actions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);
    const fixture = JSON.parse(
      readFileSync(new URL("subagent-tool-output.json", CURSOR_FIXTURE_ROOT), "utf-8"),
    );
    insertKv(dbPath, "bubble:sub-1", fixture);

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", {
      id: "composer-1",
      createdAt: 1_000,
      updatedAt: 2_000,
      subagentInfos: [{ id: "sub-1", title: "Reader" }],
    });

    const tool = agent
      .getSessionData("composer-1")
      .messages.find((message: { subagent_id?: string }) => message.subagent_id === "sub-1")
      ?.parts.find((part: MessagePart) => part.type === "tool");

    expect(tool).toMatchObject({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        output: [
          { type: "text", text: "first line", time_created: 0 },
          { type: "text", text: "second line", time_created: 0 },
          { type: "text", text: "third line", time_created: 0 },
        ],
      },
    });
  });

  it("falls back to untitled when no title text is available", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Assistant only",
      createdAt: 1_000,
    });

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", {
      id: "composer-1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const data = agent.getSessionData("composer-1");

    expect(data.title).toBe("Untitled Session");
  });

  it("falls back to zero tokens and reports a mismatch when tokenCount is wrong-typed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Assistant reply",
      createdAt: 1_000,
      // upstream format drift: tokenCount fields arrive as strings instead of numbers
      tokenCount: { inputTokens: "100", outputTokens: "50" },
    });

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    try {
      const agent = new CursorAgent() as any;
      agent.dbPath = dbPath;
      agent.composerCache.set("composer-1", {
        id: "composer-1",
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      const data = agent.getSessionData("composer-1");

      expect(data.messages[0]?.tokens).toEqual({ input: 0, output: 0 });
      expect(calls).toContainEqual({
        event: "agent.field_shape_mismatch",
        detail: { agentName: "cursor", field: "bubble.tokenCount.inputTokens" },
      });
      expect(calls).toContainEqual({
        event: "agent.field_shape_mismatch",
        detail: { agentName: "cursor", field: "bubble.tokenCount.outputTokens" },
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("skips a subagent chat message with a wrong-typed role and reports a mismatch", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    // upstream format drift: role arrives as a number instead of "user"/"assistant"
    insertKv(dbPath, "bubble:sub-1", {
      chatMessages: [{ role: 42, text: "should be skipped" }],
    });

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    try {
      const agent = new CursorAgent() as any;
      agent.dbPath = dbPath;
      agent.composerCache.set("composer-1", {
        id: "composer-1",
        createdAt: 1_000,
        updatedAt: 1_000,
        subagentInfos: [{ id: "sub-1", title: "Subagent" }],
      });

      const data = agent.getSessionData("composer-1");

      expect(data.messages.some((m: { id: string }) => m.id === "cursor-sub-sub-1")).toBe(false);
      expect(calls).toContainEqual({
        event: "agent.field_shape_mismatch",
        detail: { agentName: "cursor", field: "chatMessage.role" },
      });
    } finally {
      setCoreDiagnostics(null);
      expect(getCoreDiagnostics()).toBeNull();
    }
  });
});

describe("CursorAgent scan outcomes", () => {
  function makeScanningAgent(dbPath: string): CursorAgent {
    const agent = new CursorAgent();
    Object.assign(agent, { dbPath });
    return agent;
  }

  it("reports a corrupt database as a failure", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "state.vscdb");
    writeFileSync(dbPath, "this is not a sqlite file");

    expect(() => makeScanningAgent(dbPath).scan()).toThrow(SessionScanError);
  });

  it("reports a missing composer table as a failure", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "state.vscdb");
    new Database(dbPath).close();

    expect(() => makeScanningAgent(dbPath).scan()).toThrow(SessionScanError);
  });

  it("CS-273: throws instead of returning empty messages when the bubble query fails", () => {
    const agent = new CursorAgent() as unknown as {
      loadMessagesFromBubbles(db: unknown, composerId: string, model: string | null): unknown;
    };
    const failingDb = {
      prepare: () => {
        throw new Error("database is locked");
      },
    };

    // A broken database must surface as a scan error, never as a session
    // that silently renders with zero messages.
    expect(() => agent.loadMessagesFromBubbles(failingDb, "composer-1", null)).toThrow(
      SessionScanError,
    );
  });

  it("returns an empty result for a readable empty database", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);

    expect(makeScanningAgent(createCursorDb(tempDir)).scan()).toEqual([]);
  });

  it("re-prices a cached head after missing model pricing arrives", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);
    const model = "vendor/cursor-pricing-later";
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

    insertKv(dbPath, "composerData:composer-1", {
      id: "composer-1",
      name: "Pricing session",
      modelConfig: { modelName: model },
      createdAt: 1_000,
      updatedAt: 2_000,
      inputTokenCount: 100,
      outputTokenCount: 20,
    });
    insertKv(dbPath, "bubbleId:composer-1:user", {
      type: 1,
      text: "Price this session",
      createdAt: 1_100,
    });
    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Done",
      createdAt: 1_200,
      modelInfo: { modelName: model },
      tokenCount: { inputTokens: 100, outputTokens: 20 },
    });

    const agent = makeScanningAgent(dbPath);
    const cached = agent.scan();
    expect(cached[0]?.stats.total_cost).toBe(0);
    expect(agent.getSessionCacheMeta("composer-1")?.unpricedModels).toEqual([model]);
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, cached).hasChanges).toBe(false);

    pricingAvailable = true;
    const changed = agent.checkForChanges(Number.MAX_SAFE_INTEGER, cached);
    expect(changed.hasChanges).toBe(true);

    const refreshed = agent.incrementalScan(cached, []);
    expect(refreshed[0]?.stats.total_cost).toBeGreaterThan(0);
    expect(agent.getSessionCacheMeta("composer-1")?.unpricedModels).toBeUndefined();
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, refreshed).hasChanges).toBe(false);
  });
});
