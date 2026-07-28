import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeSqliteAgent } from "../opencode-sqlite.js";
import { SessionScanError } from "../base.js";
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

afterEach(() => {
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
