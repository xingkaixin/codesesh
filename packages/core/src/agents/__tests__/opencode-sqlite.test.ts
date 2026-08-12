import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeSqliteAgent } from "../opencode-sqlite.js";
import { SessionScanError } from "../base.js";
import type { ModelPricing } from "../../pricing/fetcher.js";
import { pricingResolver } from "../../pricing/resolver.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

const tempDirs: string[] = [];

function createDatabase(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-sqlite-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "agent.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      version TEXT,
      summary_files TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
  ).run("s1", "", 1_000, 2_000, "/workspace/project");
  db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "m1",
    "s1",
    JSON.stringify({
      role: "user",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      tokens: { input: 1_000, output: 500 },
    }),
    1_100,
  );
  db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "p1",
    "m1",
    JSON.stringify({ type: "text", text: "Implement cache tests" }),
    1_100,
  );
  db.close();
  return dbPath;
}

function createDatabaseWithMessageData(messageData: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-sqlite-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "agent.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      version TEXT,
      summary_files TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
  ).run("s1", "", 1_000, 2_000, "/workspace/project");
  db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "m1",
    "s1",
    messageData,
    1_100,
  );
  db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "p1",
    "m1",
    JSON.stringify({ type: "text", text: "Implement cache tests" }),
    1_100,
  );
  db.close();
  return dbPath;
}

function createDatabaseWithRelatedHistory(unrelatedChildren: number): string {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-related-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "agent.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      version TEXT,
      summary_files TEXT,
      parent_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO session (id, title, time_created, time_updated, directory, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    insertSession.run("recent-root", "Root", 10_000, 20_000, "/workspace", null);
    insertSession.run("child", "Child", 11_000, 14_000, "/workspace", "recent-root");
    insertSession.run("grandchild", "Grandchild", 12_000, 13_000, "/workspace", "child");
    insertSession.run(
      "great-grandchild",
      "Great grandchild",
      13_000,
      12_000,
      "/workspace",
      "grandchild",
    );
    insertSession.run("historical-root", "Old root", 1, 1, "/workspace", null);
    insertSession.run("orphan", "Orphan", 2, 2, "/workspace", "missing");
    insertSession.run("cycle-a", "Cycle A", 3, 3, "/workspace", "cycle-b");
    insertSession.run("cycle-b", "Cycle B", 4, 4, "/workspace", "cycle-a");
    for (let index = 0; index < unrelatedChildren; index += 1) {
      insertSession.run(
        `historical-child-${index}`,
        "Old child",
        index + 10,
        index + 10,
        "/workspace",
        "historical-root",
      );
    }
    for (const [index, sessionId] of [
      "recent-root",
      "child",
      "grandchild",
      "great-grandchild",
    ].entries()) {
      const messageId = `message-${sessionId}`;
      insertMessage.run(
        messageId,
        sessionId,
        JSON.stringify({ role: index === 0 ? "user" : "assistant" }),
        10_000 + index,
      );
      insertPart.run(
        `part-${sessionId}`,
        messageId,
        JSON.stringify({ type: "text", text: sessionId }),
        10_000 + index,
      );
    }
  })();
  db.close();
  return dbPath;
}

function createDatabaseWithRootChildren(rootCount: number): string {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-related-roots-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "agent.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      version TEXT,
      summary_files TEXT,
      parent_id TEXT
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO session (id, title, time_created, time_updated, directory, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let index = 0; index < rootCount; index += 1) {
      const rootId = `root-${index}`;
      insertSession.run(rootId, "Root", 20_000 + index, 20_000 + index, "/workspace", null);
      insertSession.run(
        `child-${index}`,
        "Child",
        10_000 + index,
        10_000 + index,
        "/workspace",
        rootId,
      );
    }
  })();
  db.close();
  return dbPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  setCoreDiagnostics(null);
});

describe("OpenCodeSqliteAgent", () => {
  it("builds matching heads and details through the shared SQLite adapter", () => {
    const dbPath = createDatabase();
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });

    expect(agent.isAvailable()).toBe(true);
    expect(agent.scan({ from: 0 })).toEqual([
      expect.objectContaining({
        id: "s1",
        slug: "test-agent/s1",
        title: "Implement cache tests",
        stats: expect.objectContaining({
          message_count: 1,
          total_input_tokens: 1_000,
          total_output_tokens: 500,
          cost_source: "estimated",
        }),
      }),
    ]);

    expect(agent.getSessionData("s1")).toMatchObject({
      title: "Implement cache tests",
      stats: { message_count: 1, cost_source: "estimated" },
      messages: [
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          cost_source: "estimated",
          parts: [{ type: "text", text: "Implement cache tests" }],
        },
      ],
    });
  });

  it("leaves zero-cost heads and details without a cost source", () => {
    const dbPath = createDatabaseWithMessageData(
      JSON.stringify({
        role: "assistant",
        modelID: "claude-sonnet-4-6",
        tokens: { input: 0, output: 0 },
      }),
    );
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });

    expect(agent.isAvailable()).toBe(true);
    const [head] = agent.scan({ from: 0 });
    const detail = agent.getSessionData("s1");

    expect(head?.stats.total_cost).toBe(0);
    expect(head?.stats.cost_source).toBeUndefined();
    expect(detail.stats.total_cost).toBe(0);
    expect(detail.stats.cost_source).toBeUndefined();
    expect(detail.messages[0]?.cost_source).toBeUndefined();
  });

  it("invalidates cached heads from an older parser revision", () => {
    const dbPath = createDatabase();
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();
    const heads = agent.scan({ from: 0 });

    expect(agent.getSessionMetaMap().get("s1")).toMatchObject({
      headParserVersion: "opencode-sqlite-head-v1",
    });
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, heads).hasChanges).toBe(false);

    agent.setSessionMetaMap(
      new Map([["s1", { id: "s1", sourcePath: dbPath, headParserVersion: "legacy" }]]),
    );
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, heads).hasChanges).toBe(true);
  });

  it("tracks missing pricing per cached SQLite head", () => {
    const dbPath = createDatabase();
    const model = "vendor/opencode-pricing-later";
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
    const db = new Database(dbPath);
    db.prepare("UPDATE message SET data = ? WHERE id = 'm1'").run(
      JSON.stringify({
        role: "user",
        modelID: model,
        tokens: { input: 100, output: 20 },
      }),
    );
    db.prepare("UPDATE session SET time_created = ?, time_updated = ? WHERE id = 's1'").run(
      Date.now() - 1_000,
      Date.now(),
    );
    db.close();

    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();
    const cached = agent.scan({ from: 0 });
    expect(cached[0]?.stats.total_cost).toBe(0);
    expect(agent.getSessionMetaMap().get("s1")?.unpricedModels).toEqual([model]);
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, cached).hasChanges).toBe(false);

    pricingAvailable = true;
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, cached).hasChanges).toBe(true);

    const refreshed = agent.incrementalScan(cached, []);
    expect(refreshed[0]?.stats.total_cost).toBeGreaterThan(0);
    expect(agent.getSessionMetaMap().get("s1")?.unpricedModels).toBeUndefined();
    expect(agent.checkForChanges(Number.MAX_SAFE_INTEGER, refreshed).hasChanges).toBe(false);
  });

  it("falls back to an empty message record and reports drift when message data isn't a JSON object", () => {
    const dbPath = createDatabaseWithMessageData("null");
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new OpenCodeSqliteAgent({
      name: "test-agent-data-drift",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });

    expect(agent.getSessionData("s1")).toMatchObject({
      messages: [{ role: "assistant", model: null, tokens: undefined, cost: 0 }],
    });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "test-agent-data-drift", field: "message.data" },
    });
  });

  it("falls back on per-field type drift (role/model/tokens) and reports each mismatch once", () => {
    const dbPath = createDatabaseWithMessageData(
      JSON.stringify({ role: "system", modelID: 42, tokens: "not-an-object" }),
    );
    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new OpenCodeSqliteAgent({
      name: "test-agent-field-drift",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });

    expect(agent.getSessionData("s1")).toMatchObject({
      messages: [{ role: "assistant", model: null, tokens: undefined }],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          event: "agent.field_shape_mismatch",
          detail: { agentName: "test-agent-field-drift", field: "message.role" },
        },
        {
          event: "agent.field_shape_mismatch",
          detail: { agentName: "test-agent-field-drift", field: "message.modelID" },
        },
        {
          event: "agent.field_shape_mismatch",
          detail: { agentName: "test-agent-field-drift", field: "message.tokens" },
        },
      ]),
    );
  });
});

describe("CS-206: database scans preserve the requested window", () => {
  it("applies an inclusive upper bound to roots without restricting related rows", () => {
    const dbPath = createDatabaseWithRootChildren(2);
    const db = new Database(dbPath);
    db.prepare("UPDATE session SET time_created = ?, time_updated = ? WHERE id = ?").run(
      25_000,
      25_000,
      "child-0",
    );
    db.close();
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();

    const heads = agent.scan({
      from: 15_000,
      to: 20_000,
    });

    expect(heads.map((head) => head.id)).toEqual(["child-0", "root-0"]);
  });
});

describe("CS-180: related session reads stay inside the selected roots", () => {
  it("does not return unrelated historical child rows across the SQLite seam", () => {
    const dbPath = createDatabaseWithRelatedHistory(10_000);
    const diagnostics: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => diagnostics.push({ event, detail }),
      warn: vi.fn(),
    });
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();

    const heads = agent.scan({ from: 15_000 });

    expect(heads.map((head) => head.id)).toEqual([
      "recent-root",
      "child",
      "grandchild",
      "great-grandchild",
    ]);
    expect(diagnostics).toContainEqual({
      event: "agent.related_sessions.query",
      detail: expect.objectContaining({
        agent_name: "test-agent",
        root_count: 1,
        candidate_rows: 3,
        related_rows: 3,
      }),
    });
  });

  it("chunks seed bindings without losing or duplicating descendants", () => {
    const dbPath = createDatabaseWithRootChildren(501);
    const diagnostics: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => diagnostics.push({ event, detail }),
      warn: vi.fn(),
    });
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();

    const heads = agent.scan({ from: 15_000 });
    const ids = new Set(heads.map((head) => head.id));

    expect(heads).toHaveLength(1_002);
    expect(ids.size).toBe(1_002);
    expect(["root-0", "child-0", "root-500", "child-500"].every((id) => ids.has(id))).toBe(true);
    expect(diagnostics).toContainEqual({
      event: "agent.related_sessions.query",
      detail: expect.objectContaining({
        root_count: 501,
        query_count: 2,
        candidate_rows: 501,
        related_rows: 501,
      }),
    });
  });

  it("skips related queries when disabled or when no roots match", () => {
    const dbPath = createDatabaseWithRootChildren(2);
    const diagnostics: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => diagnostics.push({ event, detail }),
      warn: vi.fn(),
    });
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();

    expect(
      agent.scan({ from: 15_000, includeRelatedSessions: false }).map((head) => head.id),
    ).toEqual(["root-1", "root-0"]);
    expect(agent.scan({ from: 30_000 })).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("terminates when malformed parent links form a cycle", () => {
    const dbPath = createDatabaseWithRelatedHistory(0);
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    const db = new Database(dbPath, { readonly: true });

    try {
      const rows = (
        agent as unknown as {
          readRelatedSessionRows(
            database: Database.Database,
            rootIds: string[],
          ): Record<string, unknown>[];
        }
      ).readRelatedSessionRows(db, ["cycle-a"]);

      expect(rows.map((row) => row.id)).toEqual(["cycle-a", "cycle-b"]);
    } finally {
      db.close();
    }
  });
});

describe("CS-138: unreadable databases are not empty scans", () => {
  function makeAgent(dbPath: string) {
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();
    return agent;
  }

  function tempFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-scan-failure-"));
    tempDirs.push(dir);
    return join(dir, name);
  }

  it("reports a corrupt database as a failure", () => {
    const dbPath = tempFile("corrupt.db");
    writeFileSync(dbPath, "this is not a sqlite file");

    expect(() => makeAgent(dbPath).scan({ from: 0 })).toThrow(SessionScanError);
  });

  it("reports a missing session table as a failure", () => {
    const dbPath = tempFile("empty.db");
    new Database(dbPath).close();

    expect(() => makeAgent(dbPath).scan({ from: 0 })).toThrow(SessionScanError);
  });

  it("still reports a readable but empty database as an empty scan", () => {
    const dbPath = createDatabase();
    const db = new Database(dbPath);
    db.exec("DELETE FROM part; DELETE FROM message; DELETE FROM session;");
    db.close();

    expect(makeAgent(dbPath).scan({ from: 0 })).toEqual([]);
  });
});

describe("CS-144: session detail reads parts in one query", () => {
  function seedDetail(options: {
    messages: number;
    partsEach: number;
    extra?: (db: Database.Database) => void;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-detail-batch-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER,
        slug TEXT, directory TEXT, version TEXT, summary_files TEXT
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER);
    `);
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?,?,?,?,?)",
    ).run("s1", "Detail", 1_000, 2_000, "/workspace/project");
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, data, time_created) VALUES (?,?,?,?)",
    );
    const insertPart = db.prepare(
      "INSERT INTO part (id, message_id, data, time_created) VALUES (?,?,?,?)",
    );
    db.transaction(() => {
      for (let index = 0; index < options.messages; index += 1) {
        const id = `m${String(index).padStart(4, "0")}`;
        insertMessage.run(
          id,
          "s1",
          JSON.stringify({ role: index % 2 ? "assistant" : "user", modelID: "claude-sonnet-4-6" }),
          1_000 + index,
        );
        for (let part = 0; part < options.partsEach; part += 1) {
          insertPart.run(
            `${id}-${part}`,
            id,
            JSON.stringify({ type: "text", text: `body ${index}.${part}` }),
            1_000 + index,
          );
        }
      }
      options.extra?.(db);
    })();
    db.close();
    return dbPath;
  }

  function detailAgent(dbPath: string) {
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();
    return agent;
  }

  function countPartQueries(run: () => void): number {
    let queries = 0;
    const prepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql.includes("FROM part")) queries += 1;
      return prepare.call(this, sql) as ReturnType<Database.Database["prepare"]>;
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return queries;
  }

  // One query per message meant M+2 reads, each scanning the part table when no
  // index on part(message_id) exists.
  it.each([5, 200])("issues one part query for %i messages", (messages) => {
    const agent = detailAgent(seedDetail({ messages, partsEach: 2 }));
    let detail: ReturnType<typeof agent.getSessionData> | undefined;

    const queries = countPartQueries(() => {
      detail = agent.getSessionData("s1");
    });

    expect(detail?.messages).toHaveLength(messages);
    expect(queries).toBe(1);
  });

  it("keeps message and part order", () => {
    const agent = detailAgent(seedDetail({ messages: 3, partsEach: 2 }));

    const detail = agent.getSessionData("s1");

    expect(detail.messages.map((message) => message.id)).toEqual(["m0000", "m0001", "m0002"]);
    expect(detail.messages[0]?.parts.map((part) => ("text" in part ? part.text : ""))).toEqual([
      "body 0.0",
      "body 0.1",
    ]);
  });

  it("drops messages whose parts are all internal or malformed", () => {
    const agent = detailAgent(
      seedDetail({
        messages: 1,
        partsEach: 1,
        extra: (db) => {
          db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
            "m-internal",
            "s1",
            JSON.stringify({ role: "assistant" }),
            9_000,
          );
          db.prepare("INSERT INTO part VALUES (?,?,?,?)").run(
            "m-internal-0",
            "m-internal",
            JSON.stringify({ type: "step-start" }),
            9_000,
          );
          db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
            "m-empty",
            "s1",
            JSON.stringify({ role: "assistant" }),
            9_100,
          );
        },
      }),
    );

    const detail = agent.getSessionData("s1");

    expect(detail.messages.map((message) => message.id)).toEqual(["m0000"]);
  });

  it("drives the batched read off the message index", () => {
    const dbPath = seedDetail({ messages: 2, partsEach: 1 });
    const db = new Database(dbPath, { readonly: true });

    try {
      const plan = db
        .prepare(
          `
            EXPLAIN QUERY PLAN
            SELECT p.message_id, p.data, p.time_created
            FROM part p
            JOIN message m ON m.id = p.message_id
            WHERE m.session_id = ?
            ORDER BY p.message_id, p.time_created ASC, p.id ASC
          `,
        )
        .all("s1")
        .map((row) => String((row as { detail?: unknown }).detail ?? ""))
        .join("\n");

      // Whatever the planner picks, it must not re-scan parts per message.
      expect(plan).not.toContain("CORRELATED");
    } finally {
      db.close();
    }
  });
});

describe("subagent folding degrades when task_type/parent_id are absent", () => {
  it("scans a database without task_type/parent_id columns without error", () => {
    const dbPath = createDatabase();
    const agent = new OpenCodeSqliteAgent({
      name: "opencode",
      displayName: "OpenCode",
      findDbPath: () => dbPath,
      getSessionWatchPlan: () => ({ status: "not-needed", reason: "test adapter" }),
    });
    agent.isAvailable();

    const heads = agent.scan({ from: 0 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      id: "s1",
      stats: expect.objectContaining({
        message_count: 1,
        total_input_tokens: 1_000,
        total_output_tokens: 500,
      }),
    });

    const detail = agent.getSessionData("s1");
    expect(detail.stats.total_input_tokens).toBe(1_000);
    expect(detail.messages).toHaveLength(1);
  });
});
