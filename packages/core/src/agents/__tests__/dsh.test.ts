import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionScanError } from "../base.js";
import { DshAgent } from "../dsh.js";
import { dshEncodeSegment, dshProjectKey, resolveDshDataRoot } from "../dsh-session-log.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

// Delegates to the real implementation; only the stable-snapshot test replaces
// it, so a file that keeps changing under the reader can be simulated.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const DEFAULT_ID = "session-11111111-2222-3333-4444-555555555555";
const DEFAULT_CWD = "/tmp/project";
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

let tempDirs: string[] = [];
let dataRoot = "";

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "codesesh-dsh-"));
  tempDirs.push(dataRoot);
  vi.stubEnv("DSH_HOME", dataRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Restores the delegating implementation the module mock was created with.
  vi.mocked(statSync).mockReset();
  vi.restoreAllMocks();
  setCoreDiagnostics(null);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Encoding = "zstd" | "none";

interface SessionSpec {
  id?: string;
  /** `null` writes a header without `cwd`, which DSH files under `_no-cwd`. */
  cwd?: string | null;
  header?: Record<string, unknown>;
  /** One entry per durable append batch; each becomes its own frame. */
  batches?: Record<string, unknown>[][];
  encoding?: Encoding;
  /** Replaces the encoded bytes wholesale, for corruption fixtures. */
  bytes?: Buffer;
  /** Writes into this directory instead of the header-derived one. */
  directory?: string;
}

function compressFrame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, "utf8"), CHECKSUM_OPTIONS);
}

function encodeArtifact(records: string[], encoding: Encoding): Buffer {
  const lines = records.map((record) => `${record}\n`);
  if (encoding === "none") return Buffer.from(lines.join(""), "utf8");
  return Buffer.concat(lines.map(compressFrame));
}

function sessionDirectory(cwd: string | undefined, id: string): string {
  return join(
    dataRoot,
    "sessions",
    cwd === undefined ? "_no-cwd" : dshProjectKey(cwd),
    dshEncodeSegment(id),
  );
}

function writeSession(spec: SessionSpec = {}): string {
  const id = spec.id ?? DEFAULT_ID;
  const cwd = spec.cwd === null ? undefined : (spec.cwd ?? DEFAULT_CWD);
  const encoding = spec.encoding ?? "zstd";
  const directory = spec.directory ?? sessionDirectory(cwd, id);
  mkdirSync(directory, { recursive: true });

  const header = {
    type: "session",
    version: 0,
    id,
    createdAt: 1_700_000_000_000,
    ...(cwd === undefined ? {} : { cwd }),
    delegationDepth: 0,
    ...spec.header,
  };
  const records = [
    JSON.stringify(header),
    ...(spec.batches ?? []).map((batch) => batch.map((row) => JSON.stringify(row)).join("\n")),
  ];

  const path = join(directory, encoding === "zstd" ? "session.jsonl.zstd" : "session.jsonl");
  writeFileSync(path, spec.bytes ?? encodeArtifact(records, encoding));
  return path;
}

interface AssistantSpec {
  blocks?: Record<string, unknown>[];
  usage?: Record<string, number>;
  model?: string;
  turn?: number;
  step?: number;
}

/** Builds a densely numbered event log; every event lands in one batch. */
function eventLog() {
  const events: Record<string, unknown>[] = [];
  let time = 1_700_000_000_000;

  const push = (
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown>[] => {
    time += 10;
    events.push({ type, seq: events.length, time, data, ...extra });
    return events;
  };

  return {
    events,
    raw: push,
    user(text: string, source: unknown = { kind: "user" }) {
      return push(
        "user/message",
        { id: `u${events.length}`, role: "user", content: [{ type: "text", text }], source },
        { surfaceOp: "append" },
      );
    },
    userContent(content: unknown[], source: unknown = { kind: "user" }) {
      return push(
        "user/message",
        { id: `u${events.length}`, role: "user", content, source },
        { surfaceOp: "append" },
      );
    },
    assistant(spec: AssistantSpec = {}) {
      return push(
        "assistant/message",
        {
          turn: spec.turn ?? 1,
          step: spec.step ?? 1,
          message: {
            id: `a${events.length}`,
            role: "assistant",
            content: spec.blocks ?? [{ type: "text", text: "answer" }],
            source: {
              kind: "model",
              provider: "deepseek-official",
              model: spec.model ?? "deepseek-v4-flash",
            },
          },
          ...(spec.usage ? { usage: spec.usage } : {}),
        },
        { surfaceOp: "append" },
      );
    },
    toolCall(callId: string, name: string, args: unknown, turn = 1, step = 1) {
      return push("tool/call", {
        turn,
        step,
        callId,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
    },
    toolResult(
      callId: string,
      text: string,
      options: { isError?: boolean; meta?: unknown; turn?: number; step?: number } = {},
    ) {
      return push(
        "tool/result",
        {
          turn: options.turn ?? 1,
          step: options.step ?? 1,
          message: {
            id: `t${events.length}`,
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: callId,
                content: [{ type: "text", text }],
                ...(options.isError ? { isError: true } : {}),
              },
            ],
            source: { kind: "tool", callId },
          },
          ...(options.meta === undefined ? {} : { meta: options.meta }),
        },
        { surfaceOp: "append" },
      );
    },
    chunk(chunk: Record<string, unknown>, turn = 1, step = 1) {
      return push("assistant/chunk", { turn, step, chunk });
    },
  };
}

function scanHeads(agent = new DshAgent()) {
  return { agent, heads: agent.scan() };
}

/** An enumeration failure aborts the whole pass so no baseline is discarded. */
function expectEnumerationFailure(pattern: RegExp): void {
  let caught: unknown;
  try {
    new DshAgent().scan();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SessionScanError);
  expect(String((caught as { cause?: unknown }).cause)).toMatch(pattern);
}

/** A parse failure is reported per source, leaving other sessions intact. */
function expectSourceFailure(pattern: RegExp): void {
  const failures = new DshAgent()
    .scanSessionSources()
    .outcomes.flatMap((outcome) => (outcome.status === "failed" ? [outcome.failure] : []));
  expect(failures).toHaveLength(1);
  expect(failures[0]?.message).toMatch(pattern);
}

function captureDiagnostics(): Array<{ event: string; detail?: Record<string, unknown> }> {
  const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
  setCoreDiagnostics(sink);
  return calls;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("DSH path rules", () => {
  it("encodes session ids injectively over every code unit", () => {
    expect(dshEncodeSegment("plain-id_1.2")).toBe("plain-id_1.2");
    expect(dshEncodeSegment(".")).toBe("~002E");
    expect(dshEncodeSegment("..")).toBe("~002E~002E");
    expect(dshEncodeSegment("a/b")).toBe("a~002Fb");
    expect(dshEncodeSegment("~")).toBe("~007E");
    expect(dshEncodeSegment("naïve")).toBe("na~00EFve");
    expect(() => dshEncodeSegment("")).toThrow(/empty path segment/);
  });

  it("collapses separator runs and truncates the project slug like DSH", () => {
    expect(dshProjectKey("/tmp/project")).toBe("--tmp-project--");
    expect(dshProjectKey("C:\\Users\\me")).toBe("--C-Users-me--");
    expect(dshProjectKey("//server///share")).toBe("--server-share--");
    expect(dshProjectKey("/")).toBe("--root--");
    expect(dshProjectKey("/项目")).toBe("--~9879~76EE--");
    expect(dshProjectKey(`/${"a".repeat(400)}`)).toBe(`--${"a".repeat(251)}--`);
    expect(() => dshProjectKey("")).toThrow(/empty project path/);
  });

  it("resolves the data root from DSH_HOME, ignoring blank overrides", () => {
    // Absolute overrides stay verbatim (shared readEnvPath semantics): on
    // Windows resolve() would prepend a drive letter to a POSIX-style path.
    vi.stubEnv("DSH_HOME", "/explicit/root");
    expect(resolveDshDataRoot()).toBe("/explicit/root");

    vi.stubEnv("DSH_HOME", "relative-root");
    expect(resolveDshDataRoot()).toBe(resolve("relative-root"));

    vi.stubEnv("DSH_HOME", "   ");
    expect(resolveDshDataRoot()).toBe(join(homedir(), ".dsh"));

    vi.stubEnv("DSH_HOME", "~/custom-dsh");
    expect(resolveDshDataRoot()).toBe(join(homedir(), "custom-dsh"));

    vi.stubEnv("DSH_HOME", "");
    expect(resolveDshDataRoot()).toBe(join(homedir(), ".dsh"));
  });

  it("resolves an unset DSH_HOME to the OS home", () => {
    vi.stubEnv("DSH_HOME", undefined);
    expect(resolveDshDataRoot()).toBe(join(homedir(), ".dsh"));
  });

  it("watches the session root even before it exists", () => {
    expect(new DshAgent().getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [{ root: dataRoot, path: join(dataRoot, "sessions") }],
    });
  });

  it("reports no data when the session root is absent", () => {
    expect(new DshAgent().isAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

describe("DSH Zstandard container", () => {
  it("reads every appended frame, not just the one a whole-file decode yields", () => {
    const log = eventLog();
    log.user("first question");
    log.assistant({ blocks: [{ type: "text", text: "first answer" }] });
    log.user("second question");
    log.assistant({ blocks: [{ type: "text", text: "second answer" }], step: 2 });

    const path = writeSession({
      batches: [[log.events[0]!, log.events[1]!], [log.events[2]!], [log.events[3]!]],
    });

    // The regression this guards: one shot over the file stops at frame one.
    const wholeFile = zstdDecompressSync(readFileSync(path)).toString("utf8");
    expect(wholeFile.trimEnd().split("\n")).toHaveLength(1);

    const { heads } = scanHeads();
    expect(heads[0]?.stats.message_count).toBe(4);
  });

  it("reads plaintext artifacts DSH writes with compression disabled", () => {
    const log = eventLog();
    log.user("hello");
    log.assistant();
    writeSession({ encoding: "none", batches: [log.events] });

    expect(scanHeads().heads[0]?.stats.message_count).toBe(2);
  });

  it("keeps the verified prefix when the final frame is torn", () => {
    const log = eventLog();
    log.user("kept");
    log.assistant();
    log.user("lost to the crash");

    const complete = Buffer.concat([
      compressFrame(
        `${JSON.stringify({ type: "session", version: 0, id: DEFAULT_ID, createdAt: 1, cwd: DEFAULT_CWD, delegationDepth: 0 })}\n`,
      ),
      compressFrame(
        `${[log.events[0], log.events[1]].map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ]);
    const torn = compressFrame(`${JSON.stringify(log.events[2])}\n`).subarray(0, 6);
    const warnings = captureDiagnostics();
    writeSession({ bytes: Buffer.concat([complete, torn]) });

    expect(scanHeads().heads[0]?.stats.message_count).toBe(2);
    expect(warnings.map((entry) => entry.event)).toContain("dsh.torn_session_tail");
  });

  it("ignores an unterminated final plaintext line", () => {
    const log = eventLog();
    log.user("kept");
    log.assistant();
    const header = JSON.stringify({
      type: "session",
      version: 0,
      id: DEFAULT_ID,
      createdAt: 1,
      cwd: DEFAULT_CWD,
      delegationDepth: 0,
    });
    const text = `${header}\n${log.events.map((row) => JSON.stringify(row)).join("\n")}\n{"type":"user/mes`;
    writeSession({ encoding: "none", bytes: Buffer.from(text, "utf8") });

    expect(scanHeads().heads[0]?.stats.message_count).toBe(2);
  });

  it.each([
    [
      "invalid frame magic",
      (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([1, 2, 3, 4, 5])]),
    ],
    [
      "a corrupt checksum",
      (bytes: Buffer) => {
        const damaged = Buffer.from(bytes);
        damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 0xff, damaged.length - 1);
        return damaged;
      },
    ],
  ])("refuses a log with %s", (_label, damage) => {
    const log = eventLog();
    log.user("hello");
    log.assistant();
    const path = writeSession({ batches: [log.events] });
    writeFileSync(path, damage(readFileSync(path)));

    expectSourceFailure(/corrupt Zstandard session log/);
  });

  it("refuses a complete frame that ends mid-record", () => {
    const header = `${JSON.stringify({ type: "session", version: 0, id: DEFAULT_ID, createdAt: 1, cwd: DEFAULT_CWD, delegationDepth: 0 })}\n`;
    writeSession({
      bytes: Buffer.concat([compressFrame(header), compressFrame('{"type":"user/mess')]),
    });

    expectSourceFailure(/ends mid-record/);
  });

  it("refuses a header frame carrying more than the header", () => {
    const log = eventLog();
    log.user("hello");
    const header = JSON.stringify({
      type: "session",
      version: 0,
      id: DEFAULT_ID,
      createdAt: 1,
      cwd: DEFAULT_CWD,
      delegationDepth: 0,
    });
    writeSession({
      bytes: compressFrame(`${header}\n${JSON.stringify(log.events[0])}\n`),
    });

    expectEnumerationFailure(/exactly one record/);
  });

  it("gives up on a file that changes under every read attempt", async () => {
    const log = eventLog();
    log.user("hello");
    log.assistant();
    writeSession({ batches: [log.events] });

    const real = (await vi.importActual<typeof import("node:fs")>("node:fs")).statSync;
    let identity = 0;
    vi.mocked(statSync).mockImplementation(((path: string, options?: { bigint?: boolean }) => {
      const stats = real(path, options as never) as unknown as Record<string, unknown>;
      // A fresh identity on every bigint stat: the two stats bracketing a read
      // can never agree, which is exactly what an active append looks like.
      return options?.bigint ? { ...stats, size: BigInt(identity++) } : stats;
    }) as unknown as typeof statSync);

    expectSourceFailure(/changed during every read attempt/);
  });
});

// ---------------------------------------------------------------------------
// Storage records
// ---------------------------------------------------------------------------

describe("DSH storage records", () => {
  it("expands packed chunk rows into the exact streaming events", () => {
    const header = JSON.stringify({
      type: "session",
      version: 0,
      id: DEFAULT_ID,
      createdAt: 1,
      cwd: DEFAULT_CWD,
      delegationDepth: 0,
    });
    const rows = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: {
          id: "u",
          role: "user",
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      },
      {
        type: "reasoning-chunks",
        seq0: 1,
        time0: 20,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ["think", "ing", "!"] },
      },
      {
        type: "text-chunks",
        seq0: 4,
        time0: 30,
        data: { turn: 1, step: 1, index: 1, dt: [1, -1], texts: ["par", "tial", " answer"] },
      },
      {
        type: "tool-call-chunks",
        seq0: 7,
        time0: 40,
        data: {
          turn: 1,
          step: 1,
          index: 2,
          id: "call-1",
          name: "read",
          dt: [1, 1],
          args: ['{"file', '_path":"a', '.ts"}'],
        },
      },
    ];
    writeSession({
      bytes: encodeArtifact([header, rows.map((row) => JSON.stringify(row)).join("\n")], "zstd"),
    });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    const assistant = detail.messages[1]!;
    expect(assistant.parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "thinking!" }),
      expect.objectContaining({ type: "text", text: "partial answer" }),
      expect.objectContaining({
        type: "tool",
        tool: "read",
        state: expect.objectContaining({ input: { file_path: "a.ts" } }),
      }),
    ]);
  });

  it.each([
    [
      "a dt/payload arity mismatch",
      {
        type: "text-chunks",
        seq0: 1,
        time0: 20,
        data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["a", "b", "c"] },
      },
      /does not match/,
    ],
    [
      "a non-integer seq0",
      {
        type: "text-chunks",
        seq0: 1.5,
        time0: 20,
        data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["a", "b"] },
      },
      /seq0 must be/,
    ],
    [
      "an empty payload",
      {
        type: "tool-call-chunks",
        seq0: 1,
        time0: 20,
        data: { turn: 1, step: 1, index: 0, id: "c", dt: [], args: [] },
      },
      /non-empty string array/,
    ],
  ])("refuses %s", (_label, row, message) => {
    const log = eventLog();
    log.user("hi");
    writeSession({ batches: [[log.events[0]!, row as Record<string, unknown>]] });

    expectSourceFailure(message);
  });

  it("refuses a seq gap in the committed region", () => {
    const log = eventLog();
    log.user("hi");
    log.assistant();
    (log.events[1] as { seq: number }).seq = 5;
    writeSession({ batches: [log.events] });

    expectSourceFailure(/breaks the contiguous prefix/);
  });

  it("refuses an unsupported header version without claiming corruption", () => {
    writeSession({ header: { version: 1 } });

    expectEnumerationFailure(/unsupported DSH session format version 1/);
  });

  it.each([
    [{ id: "" }, /header id must be/],
    [{ createdAt: -1 }, /createdAt must be/],
    [{ delegationDepth: 1.5 }, /delegationDepth must be/],
    [{ origin: "root" }, /origin must be/],
    [{ seedLength: -2 }, /seedLength must be/],
  ])("refuses a malformed header field %j", (header, message) => {
    // An unencodable id cannot be filed by path, so it is written by hand.
    writeSession({ header, directory: sessionDirectory(DEFAULT_CWD, DEFAULT_ID) });

    expectEnumerationFailure(message);
  });

  it("refuses an unknown required event but skips an ignorable one", () => {
    const required = eventLog();
    required.user("hi");
    required.raw("future/required", {});
    writeSession({ batches: [required.events] });
    expectSourceFailure(/unsupported required event/);

    rmSync(join(dataRoot, "sessions"), { recursive: true, force: true });
    const ignorable = eventLog();
    ignorable.user("hi");
    ignorable.raw("future/informational", {}, { ignorable: true });
    ignorable.assistant();
    writeSession({ batches: [ignorable.events] });

    expect(scanHeads().heads[0]?.stats.message_count).toBe(2);
  });

  it("refuses a seedLength beyond the event count", () => {
    const log = eventLog();
    log.user("hi");
    writeSession({ header: { seedLength: 9 }, batches: [log.events] });

    expectSourceFailure(/exceeds 1 events/);
  });
});

// ---------------------------------------------------------------------------
// Transcript projection
// ---------------------------------------------------------------------------

describe("DSH transcript projection", () => {
  it("shows human prompts and hides injected context", () => {
    const log = eventLog();
    log.user("approve?", { kind: "plugin", plugin: "user-approval" });
    log.user("what does this project do");
    log.user("AGENTS.md contents", { kind: "agent-instructions", form: "instructions" });
    log.user("skill list", { kind: "skill-catalog", form: "catalog" });
    log.assistant({ blocks: [{ type: "text", text: "it is a demo" }] });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    expect(detail.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[0]?.parts).toEqual([
      expect.objectContaining({ text: "what does this project do" }),
    ]);
  });

  it("excludes compaction replacements from the human transcript", () => {
    const log = eventLog();
    log.user("original question");
    log.assistant({ blocks: [{ type: "text", text: "original answer" }] });
    log.raw(
      "user/message",
      {
        id: "summary",
        role: "user",
        content: [{ type: "text", text: "compacted summary" }],
        source: { kind: "user" },
      },
      { surfaceOp: { op: "replace", start: 0, end: 1 }, sourceEventSeqs: [0, 1] },
    );
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    expect(detail.messages).toHaveLength(2);
    expect(JSON.stringify(detail.messages)).not.toContain("compacted summary");
  });

  it("refuses a surface event with no placement marker", () => {
    const log = eventLog();
    log.raw("user/message", {
      id: "u",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    });
    writeSession({ batches: [log.events] });

    expectSourceFailure(/has no surfaceOp/);
  });

  it("renders one card per call when a message and event describe the same call", () => {
    const log = eventLog();
    log.user("read two files");
    log.assistant({
      blocks: [
        { type: "reasoning", text: "planning" },
        { type: "tool-call", id: "call-1", name: "read", arguments: '{"file_path":"a.ts"}' },
        { type: "tool-call", id: "call-2", name: "read", arguments: '{"file_path":"b.ts"}' },
      ],
    });
    log.toolCall("call-1", "read", { file_path: "a.ts" });
    log.toolCall("call-2", "read", { file_path: "b.ts" });
    log.toolResult("call-1", "contents of a");
    log.toolResult("call-2", "contents of b", { isError: true });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    const parts = detail.messages[1]!.parts;
    expect(parts.filter((part) => part.type === "tool")).toHaveLength(2);
    expect(parts.map((part) => (part.type === "tool" ? part.state.status : part.type))).toEqual([
      "reasoning",
      "completed",
      "error",
    ]);
  });

  it("keeps an assistant tool-call block when its canonical event is missing", () => {
    const log = eventLog();
    log.user("read a file");
    log.assistant({
      blocks: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{not json" }],
    });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const tool = agent.getSessionData(heads[0]!.id).messages[1]!.parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      tool: "read",
      // Unparsable arguments stay verbatim so an interrupted call is diagnosable.
      state: { status: "running", input: "{not json" },
    });
  });

  it("refuses duplicate call ids and mismatched result identity", () => {
    const duplicate = eventLog();
    duplicate.user("hi");
    duplicate.toolCall("call-1", "read", {});
    duplicate.toolCall("call-1", "read", {});
    writeSession({ batches: [duplicate.events] });
    expectSourceFailure(/duplicate tool call id/);

    rmSync(join(dataRoot, "sessions"), { recursive: true, force: true });
    const mismatched = eventLog();
    mismatched.user("hi");
    mismatched.toolCall("call-1", "read", {});
    mismatched.raw(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: {
          id: "t",
          role: "user",
          content: [{ type: "tool-result", toolCallId: "other", content: [] }],
          source: { kind: "tool", callId: "call-1" },
        },
      },
      { surfaceOp: "append" },
    );
    writeSession({ batches: [mismatched.events] });

    expectSourceFailure(/disagrees with its call identity/);
  });

  it("prefers a settled message over the chunks that streamed it", () => {
    const log = eventLog();
    log.user("hi");
    log.chunk({ type: "text-delta", index: 0, text: "part" });
    log.chunk({ type: "text-delta", index: 0, text: "ial" });
    log.assistant({ blocks: [{ type: "text", text: "settled answer" }] });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "settled answer" }),
    ]);
  });

  it("rebuilds an interrupted step from its chunks and route metadata", () => {
    const log = eventLog();
    log.user("hi");
    log.raw("request/context", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 1_000_000,
    });
    log.chunk({ type: "reasoning-delta", index: 0, text: "thinking" });
    log.chunk({ type: "text-delta", index: 1, text: "half an " });
    log.chunk({ type: "text-delta", index: 1, text: "answer" });
    log.chunk({ type: "usage", usage: { inputTokens: 100, outputTokens: 20 } });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const detail = agent.getSessionData(heads[0]!.id);
    expect(detail.messages[1]).toMatchObject({
      role: "assistant",
      model: "deepseek-v4-flash",
      provider: "deepseek-official",
      tokens: { input: 100, output: 20 },
    });
    expect(detail.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "thinking" }),
      expect.objectContaining({ type: "text", text: "half an answer" }),
    ]);
  });

  it("prefers an assembled block over the deltas that built it", () => {
    const log = eventLog();
    log.user("hi");
    log.chunk({ type: "text-delta", index: 0, text: "draf" });
    log.chunk({ type: "block-end", index: 0, block: { type: "text", text: "assembled" } });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    expect(agent.getSessionData(heads[0]!.id).messages[1]?.parts).toEqual([
      expect.objectContaining({ text: "assembled" }),
    ]);
  });

  it("titles a session from its latest title event, then its first prompt", () => {
    const titled = eventLog();
    titled.user("what does this project do");
    titled.raw("session/title", { title: "fallback title" });
    titled.raw("session/title", { title: "final title" });
    titled.assistant();
    writeSession({ batches: [titled.events] });
    expect(scanHeads().heads[0]?.title).toBe("final title");

    rmSync(join(dataRoot, "sessions"), { recursive: true, force: true });
    const untitled = eventLog();
    untitled.user("what does this project do");
    untitled.assistant();
    writeSession({ batches: [untitled.events] });
    expect(scanHeads().heads[0]?.title).toBe("what does this project do");
  });

  it("falls back to the working directory when nothing names the session", () => {
    const log = eventLog();
    log.userContent([{ type: "image", attachment: { attachmentId: "bogus" } }]);
    log.assistant({ blocks: [{ type: "text", text: "ok" }] });
    writeSession({ batches: [log.events] });

    expect(scanHeads().heads[0]?.title).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

describe("DSH lineage", () => {
  it("counts only its own suffix and points at its parent", () => {
    const log = eventLog();
    log.user("inherited question");
    log.assistant({
      blocks: [{ type: "text", text: "inherited answer" }],
      usage: { inputTokens: 5_000, outputTokens: 500 },
    });
    log.raw("session/title", { title: "inherited title" });
    log.user("own question");
    log.assistant({
      blocks: [{ type: "text", text: "own answer" }],
      usage: { inputTokens: 100, outputTokens: 20 },
      step: 2,
    });
    writeSession({
      header: { parentSession: "parent-session", seedLength: 3 },
      batches: [log.events],
    });

    const { agent, heads } = scanHeads();
    const head = heads[0]!;
    expect(head.parent_reference).toEqual({ agentName: "dsh", sessionId: "parent-session" });
    expect(head.stats).toMatchObject({
      message_count: 2,
      total_input_tokens: 100,
      total_output_tokens: 20,
    });
    // The inherited title only applies when the child names nothing itself.
    expect(head.title).toBe("own question");
    expect(agent.getSessionData(head.id).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("uses an inherited title when the child has none of its own", () => {
    const log = eventLog();
    log.raw("session/title", { title: "inherited title" });
    log.assistant({ blocks: [{ type: "text", text: "own answer" }] });
    writeSession({ header: { seedLength: 1 }, batches: [log.events] });

    expect(scanHeads().heads[0]?.title).toBe("inherited title");
  });

  it("prefers a subagent label over the first prompt", () => {
    const log = eventLog();
    log.raw("subagent/descriptor", { label: "explore the repo" });
    log.user("go");
    log.assistant();
    writeSession({ header: { origin: "subagent", delegationDepth: 1 }, batches: [log.events] });

    expect(scanHeads().heads[0]?.title).toBe("explore the repo");
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe("DSH token accounting", () => {
  it("folds disjoint cache buckets into input without double counting reasoning", () => {
    const log = eventLog();
    log.user("hi");
    log.assistant({
      usage: {
        inputTokens: 1_000,
        outputTokens: 300,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 500,
        reasoningTokens: 100,
      },
    });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    expect(heads[0]?.stats).toMatchObject({
      total_input_tokens: 5_500,
      total_output_tokens: 300,
      total_cache_read_tokens: 4_000,
      total_cache_create_tokens: 500,
    });
    expect(heads[0]?.model_usage).toEqual({ "deepseek-v4-flash": 5_800 });
    expect(agent.getSessionData(heads[0]!.id).messages[1]?.tokens).toEqual({
      input: 5_500,
      output: 200,
      reasoning: 100,
      cache_read: 4_000,
      cache_create: 500,
    });
  });

  it("clamps reasoning that exceeds the reported output", () => {
    const log = eventLog();
    log.user("hi");
    log.assistant({ usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 50 } });
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    expect(agent.getSessionData(heads[0]!.id).messages[1]?.tokens).toMatchObject({
      output: 0,
      reasoning: 5,
    });
  });

  it("keeps the spend of an empty-content assistant message", () => {
    const log = eventLog();
    log.user("hi");
    log.assistant({ blocks: [], usage: { inputTokens: 700, outputTokens: 0 } });
    writeSession({ batches: [log.events] });

    const head = scanHeads().heads[0]!;
    expect(head.stats.message_count).toBe(1);
    expect(head.stats.total_input_tokens).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe("DSH image attachments", () => {
  const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const digest = createHash("sha256").update(bytes).digest("hex");

  function writeAttachment(objectDigest = digest, content = bytes): void {
    const directory = join(dataRoot, "attachments", "v1", "objects", objectDigest.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, objectDigest), content);
  }

  function imageBlock(overrides: Record<string, unknown> = {}) {
    return {
      type: "image",
      attachment: {
        attachmentId: `sha256:${digest}`,
        mediaType: "image/png",
        bytes: bytes.byteLength,
        width: 1,
        height: 1,
        ...overrides,
      },
    };
  }

  it("inlines a verified image beside its text", () => {
    writeAttachment();
    const log = eventLog();
    log.userContent([{ type: "text", text: "look" }, imageBlock()]);
    log.assistant();
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    expect(agent.getSessionData(heads[0]!.id).messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "look" }),
      expect.objectContaining({
        type: "image",
        mime_type: "image/png",
        data: bytes.toString("base64"),
      }),
    ]);
  });

  it.each([
    ["a missing object", () => {}, {}],
    ["a corrupt object", () => writeAttachment(digest, Buffer.from("tampered")), {}],
    ["an unsupported media type", () => writeAttachment(), { mediaType: "image/tiff" }],
    ["a non content-addressed id", () => writeAttachment(), { attachmentId: "../escape" }],
    ["a byte-length mismatch", () => writeAttachment(), { bytes: 99 }],
  ])("keeps the rest of the transcript when %s", (_label, prepare, overrides) => {
    prepare();
    const warnings = captureDiagnostics();
    const log = eventLog();
    log.userContent([{ type: "text", text: "look" }, imageBlock(overrides)]);
    log.userContent([imageBlock(overrides)]);
    log.assistant();
    writeSession({ batches: [log.events] });

    const { agent, heads } = scanHeads();
    const messages = agent.getSessionData(heads[0]!.id).messages;
    expect(messages[0]?.parts).toEqual([expect.objectContaining({ text: "look" })]);
    // An image-only message keeps its slot with a placeholder instead of vanishing.
    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({ text: "Image attachment unavailable" }),
    ]);
    expect(warnings.map((entry) => entry.event)).toContain("dsh.attachment_unreadable");
  });
});

// ---------------------------------------------------------------------------
// Source synchronization
// ---------------------------------------------------------------------------

describe("DSH source synchronization", () => {
  function baseBatch() {
    const log = eventLog();
    log.user("hi");
    log.assistant();
    return log;
  }

  it("keeps the fingerprint stable until the artifact changes", () => {
    const log = baseBatch();
    const path = writeSession({ batches: [log.events] });

    const agent = new DshAgent();
    const before = agent.listSessionSources()[0]!.fingerprint;
    expect(agent.listSessionSources()[0]!.fingerprint).toBe(before);

    const appended = eventLog();
    appended.user("hi");
    appended.assistant();
    appended.user("again");
    appended.assistant({ step: 2 });
    writeFileSync(
      path,
      Buffer.concat([
        readFileSync(path),
        compressFrame(
          `${[appended.events[2], appended.events[3]].map((row) => JSON.stringify(row)).join("\n")}\n`,
        ),
      ]),
    );
    expect(agent.listSessionSources()[0]!.fingerprint).not.toBe(before);
    expect(agent.scan()[0]?.stats.message_count).toBe(4);
  });

  it("applies the scan window by artifact mtime", () => {
    writeSession({ batches: [baseBatch().events] });

    const agent = new DshAgent();
    expect(agent.listSessionSources({ to: 1_000 })).toEqual([]);
    expect(agent.listSessionSources()).toHaveLength(1);
  });

  it("filters a session whose events are all context", () => {
    const log = eventLog();
    log.user("system prompt", { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" });
    writeSession({ batches: [log.events] });

    const agent = new DshAgent();
    expect(agent.isAvailable()).toBe(true);
    expect(agent.scan()).toEqual([]);
  });

  it("drops a cached head that no longer has visible messages", () => {
    const agent = new DshAgent();
    expect(
      agent.filterCachedSessions([
        {
          id: "a",
          slug: "dsh/a",
          title: "a",
          directory: "/tmp",
          time_created: 1,
          stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
        },
        {
          id: "b",
          slug: "dsh/b",
          title: "b",
          directory: "/tmp",
          time_created: 1,
          stats: { message_count: 2, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
        },
      ]),
    ).toHaveLength(1);
  });

  it("refuses a duplicate id across project directories", () => {
    writeSession({ cwd: "/tmp/one", batches: [baseBatch().events] });
    writeSession({ cwd: "/tmp/two", batches: [baseBatch().events] });

    expectEnumerationFailure(/duplicate DSH session id/);
  });

  it("refuses an artifact filed under the wrong project directory", () => {
    writeSession({
      batches: [baseBatch().events],
      directory: sessionDirectory("/tmp/elsewhere", DEFAULT_ID),
    });

    expectEnumerationFailure(/header identifies/);
  });

  it("refuses a root that mixes physical encodings", () => {
    writeSession({ id: "session-a", batches: [baseBatch().events] });
    writeSession({ id: "session-b", encoding: "none", batches: [baseBatch().events] });

    expectEnumerationFailure(/mixes/);
  });

  it("refuses one session directory holding both encodings", () => {
    writeSession({ batches: [baseBatch().events] });
    writeSession({ encoding: "none", batches: [baseBatch().events] });

    expectEnumerationFailure(/both physical encodings/);
  });

  it("refuses the obsolete flat-file layout", () => {
    writeSession({ batches: [baseBatch().events] });
    writeFileSync(join(dataRoot, "sessions", dshProjectKey(DEFAULT_CWD), "legacy.jsonl"), "{}\n");

    expectEnumerationFailure(/flat-file layout/);
  });

  it("stays available when enumeration fails for a reason other than absence", () => {
    writeSession({ batches: [baseBatch().events] });
    writeFileSync(join(dataRoot, "sessions", dshProjectKey(DEFAULT_CWD), "legacy.jsonl"), "{}\n");

    expect(new DshAgent().isAvailable()).toBe(true);
  });

  it("files a session with no working directory under _no-cwd", () => {
    writeSession({ cwd: null, batches: [baseBatch().events] });

    const head = scanHeads().heads[0]!;
    expect(head.directory).toBe("");
    expect(head.title).toBe("hi");
  });

  it("rejects a detail request for an unknown session", () => {
    expect(() => new DshAgent().getSessionData("missing")).toThrow(/Session not found/);
  });
});
