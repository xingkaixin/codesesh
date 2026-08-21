import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorAgent } from "../cursor.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface BubbleSpec {
  suffix: string;
  bubble: Record<string, unknown>;
}

function createDb(entries: Array<[string, unknown]>): string {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-cursor-shape-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const write = db.transaction((rows: Array<[string, unknown]>) => {
    for (const [key, value] of rows) insert.run(key, JSON.stringify(value));
  });
  write(entries);
  db.close();
  return dbPath;
}

function composer(id: string, overrides: Record<string, unknown> = {}) {
  return [
    `composerData:${id}`,
    { composerId: id, createdAt: 1_000, lastUpdatedAt: 2_000, ...overrides },
  ] as [string, unknown];
}

function bubbles(composerId: string, specs: BubbleSpec[]): Array<[string, unknown]> {
  return specs.map(({ suffix, bubble }) => [`bubbleId:${composerId}:${suffix}`, bubble]);
}

function makeAgent(dbPath: string) {
  const agent = new CursorAgent();
  (agent as unknown as { dbPath: string }).dbPath = dbPath;
  return agent;
}

function textOf(agent: CursorAgent, sessionId: string): string[] {
  return agent
    .getSessionData(sessionId)
    .messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.text),
    );
}

describe("CS-142: Cursor scan shape", () => {
  it("uses the composer id consistently in fast and full scans", () => {
    const dbPath = createDb([
      composer("c1"),
      ...bubbles("c1", [
        { suffix: "a", bubble: { type: 1, text: "question", requestId: "legacy-request" } },
      ]),
    ]);
    const fastHeads = makeAgent(dbPath).scan({ from: 0, fast: true });
    const fullHeads = makeAgent(dbPath).scan({ from: 0 });

    expect(fastHeads.map((head) => head.reference.sessionId)).toEqual(["c1"]);
    expect(fullHeads.map((head) => head.reference.sessionId)).toEqual(["c1"]);
  });

  it("resolves legacy request ids to the canonical composer id", () => {
    const dbPath = createDb([
      composer("c1"),
      ...bubbles("c1", [
        { suffix: "a", bubble: { type: 1, text: "question", requestId: "legacy-request" } },
      ]),
    ]);
    const agent = makeAgent(dbPath);

    const detail = agent.getSessionData("legacy-request");

    expect(detail.reference.sessionId).toBe("c1");
    expect(detail.reference).toEqual({ agentName: "cursor", sessionId: "c1" });
  });

  it("migrates cached request-id metadata during a full scan", () => {
    const dbPath = createDb([
      composer("c1"),
      ...bubbles("c1", [
        { suffix: "a", bubble: { type: 1, text: "question", requestId: "legacy-request" } },
      ]),
    ]);
    const agent = makeAgent(dbPath);
    agent.restoreSessionCacheMeta({
      "legacy-request": { id: "legacy-request", sourcePath: dbPath },
    });

    agent.scan({ from: 0 });

    expect(agent.getSessionCacheMeta("legacy-request")).toBeUndefined();
    expect(agent.getSessionCacheMeta("c1")?.id).toBe("c1");
  });

  it("keeps message order by insertion, not by key", () => {
    const dbPath = createDb([
      composer("c1"),
      ...bubbles("c1", [
        { suffix: "z", bubble: { type: 1, text: "written first" } },
        { suffix: "a", bubble: { type: 2, text: "written second" } },
      ]),
    ]);
    const agent = makeAgent(dbPath);

    const heads = agent.scan({ from: 0 });

    expect(textOf(agent, heads[0]!.reference.sessionId)).toEqual([
      "written first",
      "written second",
    ]);
  });

  it("drops a composer whose bubbles are all malformed or internal", () => {
    const dbPath = createDb([
      composer("empty"),
      composer("kept"),
      ["bubbleId:empty:a", "{not json"],
      ...bubbles("kept", [{ suffix: "a", bubble: { type: 1, text: "visible" } }]),
    ]);

    const heads = makeAgent(dbPath).scan({ from: 0 });

    expect(heads.map((head) => head.reference.sessionId)).toEqual(["kept"]);
  });

  it("keeps a composer that only has subagents", () => {
    const dbPath = createDb([composer("sub", { subagentInfos: [{ name: "explorer" }] })]);

    const heads = makeAgent(dbPath).scan({ from: 0 });

    expect(heads.map((head) => head.reference.sessionId)).toEqual(["sub"]);
  });

  it("applies the scan window to the composer's update time", () => {
    const dbPath = createDb([
      composer("old", { createdAt: 100, lastUpdatedAt: 200 }),
      composer("new", { createdAt: 5_000, lastUpdatedAt: 6_000 }),
      ...bubbles("old", [{ suffix: "a", bubble: { type: 1, text: "old" } }]),
      ...bubbles("new", [{ suffix: "a", bubble: { type: 1, text: "new" } }]),
    ]);

    const heads = makeAgent(dbPath).scan({ from: 1_000 });

    expect(heads.map((head) => head.reference.sessionId)).toEqual(["new"]);
  });

  it("releases composers excluded from the next scan", () => {
    const dbPath = createDb([
      composer("stale"),
      ...bubbles("stale", [{ suffix: "a", bubble: { type: 1, text: "old" } }]),
    ]);
    const agent = makeAgent(dbPath);

    agent.scan({ from: 0 });
    expect((agent as any).composerCache.has("stale")).toBe(true);

    agent.scan({ from: 3_000 });

    expect((agent as any).composerCache.has("stale")).toBe(false);
    expect(textOf(agent, "stale")).toEqual(["old"]);
  });

  it("uses the same update-time fallback in heads and details", () => {
    const dbPath = createDb([
      composer("c1", { lastUpdatedAt: undefined, lastSendTime: 2_500 }),
      ...bubbles("c1", [{ suffix: "a", bubble: { type: 1, text: "question" } }]),
    ]);
    const agent = makeAgent(dbPath);

    const [head] = agent.scan({ from: 0 });
    const detail = agent.getSessionData(head!.reference.sessionId);

    expect(head?.time_updated).toBe(2_500);
    expect(detail.time_updated).toBe(head?.time_updated);
  });

  it("counts messages and totals from the bubbles it parsed", () => {
    const dbPath = createDb([
      composer("c1", { model: "gpt-4" }),
      ...bubbles("c1", [
        {
          suffix: "a",
          bubble: {
            type: 1,
            text: "question",
            tokenCount: { inputTokens: 10, outputTokens: 0 },
          },
        },
        {
          suffix: "b",
          bubble: {
            type: 2,
            text: "answer",
            tokenCount: { inputTokens: 0, outputTokens: 5 },
          },
        },
      ]),
    ]);

    const heads = makeAgent(dbPath).scan({ from: 0 });

    expect(heads[0]?.stats.message_count).toBe(2);
  });
});

describe("CS-142: Cursor scan reads bubbles once", () => {
  function seedComposers(composerCount: number, bubblesEach: number): string {
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < composerCount; index += 1) {
      const id = `composer-${String(index).padStart(4, "0")}`;
      entries.push(composer(id));
      for (let bubble = 0; bubble < bubblesEach; bubble += 1) {
        entries.push([
          `bubbleId:${id}:${String(bubble).padStart(3, "0")}`,
          { type: bubble % 2 === 0 ? 1 : 2, text: `message ${bubble}`, requestId: `req-${index}` },
        ]);
      }
    }
    return createDb(entries);
  }

  function countBubbleQueries(run: () => void): number {
    let queries = 0;
    const prepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql.includes("bubbleId:")) queries += 1;
      return prepare.call(this, sql) as ReturnType<Database.Database["prepare"]>;
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return queries;
  }

  // The old scan issued two full-table queries per composer, so the count grew
  // with the number of composers rather than staying flat.
  it.each([
    [10, 3],
    [200, 3],
  ])("issues one bubble query for %i composers", (composerCount, bubblesEach) => {
    const dbPath = seedComposers(composerCount, bubblesEach);
    const agent = makeAgent(dbPath);
    let heads: ReturnType<typeof agent.scan> = [];

    const queries = countBubbleQueries(() => {
      heads = agent.scan({ from: 0 });
    });

    expect(heads).toHaveLength(composerCount);
    expect(queries).toBe(1);
  });

  it("reads bubbles in primary key order instead of scanning unordered", () => {
    const dbPath = seedComposers(2, 2);
    const db = new Database(dbPath, { readonly: true });

    try {
      const plan = db
        .prepare(
          `
            EXPLAIN QUERY PLAN
            SELECT rowid AS row_id, key, value
            FROM cursorDiskKV
            WHERE key LIKE 'bubbleId:%'
            ORDER BY key
          `,
        )
        .all()
        .map((row) => String((row as { detail?: unknown }).detail ?? ""))
        .join("\n");

      expect(plan).toContain("USING INDEX");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      db.close();
    }
  });
});
