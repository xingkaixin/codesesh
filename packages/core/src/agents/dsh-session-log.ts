/**
 * Read-only reader for DeepSeek Harness (DSH) v0 session artifacts.
 *
 * A DSH log is not one compressed blob: it is a concatenation of independently
 * checksummed Zstandard frames — the first holding the header line, each later
 * one holding a durable append batch. Decompressing the whole file at once
 * yields only the first frame, so this module scans frame ranges structurally
 * and decodes them one by one. It also expands the packed `*-chunks` storage
 * rows DSH writes for streaming deltas, so a physical JSONL line count is
 * never mistaken for an event count.
 *
 * CodeSesh is a strictly read-only consumer: nothing here writes, truncates or
 * repairs a DSH artifact, and a torn tail is reported as a warning over the
 * verified complete prefix.
 */
import { closeSync, openSync, readFileSync, readSync, statSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as zlib from "node:zlib";
import { getCoreDiagnostics } from "../utils/diagnostics.js";

/** Physical encoding of a session artifact; DSH defaults to `zstd`. */
export type DshEncoding = "zstd" | "none";

/** The on-disk session format version this reader understands. */
const DSH_FORMAT_VERSION = 0;

/** DSH truncates a project-directory slug to this many characters. */
const PROJECT_SLUG_MAX_LENGTH = 251;

/** Reads racing an active append retry this many times before failing. */
const STABLE_READ_ATTEMPTS = 3;

/** Enough for any DSH header record; a longer one falls back to a whole-file read. */
const HEADER_PREFIX_BYTES = 64 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * DSH's `KNOWN_SESSION_EVENT_TYPES` for format version 0. An unrecognized type
 * without the envelope's `ignorable` marker means the log was written by a
 * newer harness whose semantics could change how the rest of it reads, so the
 * source is refused rather than silently reconstructed wrong.
 */
const KNOWN_DSH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
]);

/** Storage-row tags: a durable encoding vocabulary, never session events. */
const TEXT_CHUNK_ROWS: ReadonlySet<string> = new Set(["text-chunks", "reasoning-chunks"]);
const TOOL_CALL_CHUNK_ROW = "tool-call-chunks";

/** Immutable storage metadata from a log's first record. */
export interface DshSessionHeader {
  id: string;
  createdAt: number;
  cwd: string | undefined;
  parentSession: string | undefined;
  seedLength: number | undefined;
  origin: "subagent" | undefined;
  delegationDepth: number;
  agentPreset: string | undefined;
}

/** One entry of the DSH append-only log, after storage rows are expanded. */
export interface DshEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: unknown;
  ignorable?: unknown;
}

/** A header plus the contiguous event prefix this reader could verify. */
export interface DshSessionLog {
  header: DshSessionHeader;
  events: DshEvent[];
}

export class DshSessionLogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DshSessionLogError";
  }
}

// ---------------------------------------------------------------------------
// Data root and path layout
// ---------------------------------------------------------------------------

/** Expand the tilde prefixes DSH's `expandHomePath` accepts. */
function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Reproduce DSH's `resolveDshHome`: a non-blank `DSH_HOME`, else `~/.dsh`.
 * DSH consults no XDG or Windows AppData location, so neither does this.
 */
export function resolveDshDataRoot(): string {
  const fromEnv = process.env["DSH_HOME"];
  const selected =
    fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh");
  return resolve(expandHomePath(selected));
}

export function dshSessionsRoot(dataRoot: string): string {
  return join(dataRoot, "sessions");
}

export function dshAttachmentsRoot(dataRoot: string): string {
  return join(dataRoot, "attachments", "v1");
}

export function dshLogFileName(encoding: DshEncoding): string {
  return encoding === "zstd" ? "session.jsonl.zstd" : "session.jsonl";
}

function isSafeSegmentChar(ch: string): boolean {
  return /^[A-Za-z0-9._-]$/.test(ch);
}

function escapeCodeUnit(code: number): string {
  return `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * DSH's `encodeSegment`: injective over all UTF-16 strings, so a session id
 * can never escape its directory. Operates on code units to preserve lone
 * surrogates, and special-cases `.` / `..` which are safe per character yet
 * traversing as whole segments.
 */
export function dshEncodeSegment(raw: string): string {
  if (raw.length === 0) throw new DshSessionLogError("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    out += ch !== "~" && isSafeSegmentChar(ch) ? ch : escapeCodeUnit(code);
  }
  return out;
}

/**
 * DSH's `projectKey`: a human-navigable, deliberately lossy directory name.
 * Separator runs collapse to one `-` and the slug is truncated, so the key
 * cannot recover a cwd — only the header can.
 */
export function dshProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new DshSessionLogError("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    readable += ch !== "~" && isSafeSegmentChar(ch) ? ch : escapeCodeUnit(code);
    separatorRun = false;
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, PROJECT_SLUG_MAX_LENGTH)}--`;
}

/** The artifact path the header's own identity fields name. */
export function dshLogPath(
  sessionsRoot: string,
  cwd: string | undefined,
  id: string,
  encoding: DshEncoding,
): string {
  const project = cwd === undefined ? "_no-cwd" : dshProjectKey(cwd);
  return join(sessionsRoot, project, dshEncodeSegment(id), dshLogFileName(encoding));
}

// ---------------------------------------------------------------------------
// Stable snapshot
// ---------------------------------------------------------------------------

/** A file's bytes plus the identity proving nothing changed while reading. */
export interface DshFileSnapshot {
  buffer: Buffer;
  stats: BigIntStats;
}

function sameFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/**
 * Read a file whose writer may be appending concurrently. Bracketing the read
 * with two identical `stat`s proves the bytes belong to one point in time; a
 * file that keeps changing is a transient failure the watcher retries, never a
 * reason to publish a half-read session.
 */
export function readDshFileSnapshot(sourcePath: string): DshFileSnapshot {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = statSync(sourcePath, { bigint: true });
    const buffer = readFileSync(sourcePath);
    const after = statSync(sourcePath, { bigint: true });
    if (sameFileIdentity(before, after)) return { buffer, stats: after };
  }
  throw new DshSessionLogError(
    `DSH session log ${JSON.stringify(sourcePath)} changed during every read attempt`,
  );
}

/** Identity fields that must all change together for an append to go unnoticed. */
export function dshFileIdentity(stats: BigIntStats): string[] {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map(String);
}

/** Read at most `maxBytes` from the start of a file, without loading the rest. */
function readFilePrefix(sourcePath: string, maxBytes: number): Buffer {
  const handle = openSync(sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    return buffer.subarray(0, readSync(handle, buffer, 0, maxBytes, 0));
  } finally {
    closeSync(handle);
  }
}

// ---------------------------------------------------------------------------
// Zstandard container
// ---------------------------------------------------------------------------

interface ZstdFrameRange {
  start: number;
  end: number;
}

interface ZstdFrameScan {
  frames: ZstdFrameRange[];
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number;
}

type ZstdDecompressSync = (input: Buffer) => Buffer;

/**
 * Namespace import plus a runtime probe: a named import of a function absent
 * on older Node fails at ESM link time, taking every other agent down with it.
 */
function resolveZstdDecoder(sourcePath: string): ZstdDecompressSync {
  const decoder = (zlib as { zstdDecompressSync?: ZstdDecompressSync }).zstdDecompressSync;
  if (typeof decoder !== "function") {
    throw new DshSessionLogError(
      `DSH session log ${JSON.stringify(sourcePath)} is Zstandard-compressed, but this Node ` +
        `runtime (${process.version}) has no native Zstandard decoder; DSH itself requires ` +
        "Node ^22.19.0 || >=24.0.0",
    );
  }
  return decoder;
}

/**
 * Locate structurally complete frames without decompressing any block. Only
 * the final frame may be cut short by EOF; anything else malformed is
 * corruption, because DSH publishes each batch as a whole frame.
 */
function scanZstdFrames(
  buffer: Buffer,
  sourcePath: string,
  maxFrames = Number.POSITIVE_INFINITY,
): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  const corrupt = (reason: string): never => {
    throw new DshSessionLogError(
      `corrupt Zstandard session log ${JSON.stringify(sourcePath)}: ${reason}`,
    );
  };

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
      corrupt(`invalid frame magic at byte ${offset}`);
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) corrupt(`reserved frame-header bit at byte ${offset - 1}`);

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) corrupt(`reserved block type at byte ${offset - 3}`);
      // An RLE block stores one repeated byte regardless of its declared size.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/** Decode one complete frame; Node's decoder validates the frame checksum. */
function decodeFrame(
  decoder: ZstdDecompressSync,
  buffer: Buffer,
  frame: ZstdFrameRange,
  sourcePath: string,
): string {
  try {
    return decoder(buffer.subarray(frame.start, frame.end)).toString("utf8");
  } catch (error) {
    throw new DshSessionLogError(
      `corrupt Zstandard session log ${JSON.stringify(sourcePath)}: frame at byte ${frame.start} failed validation`,
      { cause: error },
    );
  }
}

/**
 * Split one frame's plaintext into whole JSONL records. A complete frame that
 * ends mid-record is corruption, not a torn tail: DSH writes each batch as
 * newline-terminated lines inside a single frame.
 */
function frameRecords(plaintext: string, sourcePath: string, frameStart: number): string[] {
  if (!plaintext.endsWith("\n")) {
    throw new DshSessionLogError(
      `corrupt Zstandard session log ${JSON.stringify(sourcePath)}: complete frame at byte ${frameStart} ends mid-record`,
    );
  }
  return plaintext.slice(0, -1).split("\n");
}

function warnTornTail(sourcePath: string, detail: Record<string, unknown>): void {
  getCoreDiagnostics()?.warn("dsh.torn_session_tail", { source_path: sourcePath, ...detail });
}

/** Records of a compressed artifact, header line first. */
function readCompressedRecords(buffer: Buffer, sourcePath: string, headerOnly: boolean): string[] {
  const decoder = resolveZstdDecoder(sourcePath);
  const scan = scanZstdFrames(buffer, sourcePath, headerOnly ? 1 : Number.POSITIVE_INFINITY);
  const first = scan.frames[0];
  if (!first) {
    throw new DshSessionLogError(
      `DSH session log ${JSON.stringify(sourcePath)} has no complete header frame`,
    );
  }

  const headerPlaintext = decodeFrame(decoder, buffer, first, sourcePath);
  if (headerPlaintext.indexOf("\n") !== headerPlaintext.length - 1) {
    throw new DshSessionLogError(
      `corrupt Zstandard session log ${JSON.stringify(sourcePath)}: header frame does not hold exactly one record`,
    );
  }
  const records = [headerPlaintext.slice(0, -1)];
  if (headerOnly) return records;

  for (const frame of scan.frames.slice(1)) {
    records.push(
      ...frameRecords(decodeFrame(decoder, buffer, frame, sourcePath), sourcePath, frame.start),
    );
  }
  if (scan.tornStart !== undefined) {
    warnTornTail(sourcePath, { encoding: "zstd", torn_start: scan.tornStart });
  }
  return records;
}

/** Records of a plaintext artifact; an unterminated final line is a torn tail. */
function readPlaintextRecords(buffer: Buffer, sourcePath: string, headerOnly: boolean): string[] {
  const text = buffer.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline === -1) {
    throw new DshSessionLogError(
      `DSH session log ${JSON.stringify(sourcePath)} has no complete header record`,
    );
  }
  if (headerOnly) return [text.slice(0, newline)];

  const complete = text.endsWith("\n");
  const records = (complete ? text.slice(0, -1) : text).split("\n");
  if (!complete) {
    records.pop();
    warnTornTail(sourcePath, {
      encoding: "none",
      torn_bytes: text.length - text.lastIndexOf("\n") - 1,
    });
  }
  return records;
}

function readRecords(
  buffer: Buffer,
  sourcePath: string,
  encoding: DshEncoding,
  headerOnly: boolean,
): string[] {
  return encoding === "zstd"
    ? readCompressedRecords(buffer, sourcePath, headerOnly)
    : readPlaintextRecords(buffer, sourcePath, headerOnly);
}

// ---------------------------------------------------------------------------
// Header and event validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalString(value: unknown, field: string, sourcePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: header ${field} must be a string`,
    );
  }
  return value;
}

function parseJsonRecord(line: string, what: string, sourcePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: ${what} is not valid JSON`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: ${what} is not an object`,
    );
  }
  return parsed;
}

/**
 * Refuse a foreign format version before any structural check: a future format
 * need not satisfy today's shape at all, and its reader owes the user "upgrade
 * CodeSesh", never "corrupt session log".
 */
function parseHeaderRecord(line: string, sourcePath: string): DshSessionHeader {
  const parsed = parseJsonRecord(line, "header line", sourcePath);
  const version = parsed["version"];
  if (typeof version !== "number" || version !== DSH_FORMAT_VERSION) {
    throw new DshSessionLogError(
      `unsupported DSH session format version ${JSON.stringify(version)} in ${JSON.stringify(sourcePath)}; ` +
        `this build reads version ${DSH_FORMAT_VERSION}`,
    );
  }
  const invalid = (reason: string): never => {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: ${reason}`,
    );
  };

  if (parsed["type"] !== "session") invalid("first record is not a session header");
  const id = parsed["id"];
  if (typeof id !== "string" || id.length === 0) invalid("header id must be a non-empty string");
  const createdAt = parsed["createdAt"];
  if (!isCount(createdAt)) invalid("header createdAt must be a non-negative safe integer");
  const delegationDepth = parsed["delegationDepth"];
  if (!isCount(delegationDepth)) {
    invalid("header delegationDepth must be a non-negative safe integer");
  }
  const seedLength = parsed["seedLength"];
  if (seedLength !== undefined && !isCount(seedLength)) {
    invalid("header seedLength must be a non-negative safe integer");
  }
  const origin = parsed["origin"];
  if (origin !== undefined && origin !== "subagent") invalid("header origin must be 'subagent'");

  return {
    id: id as string,
    createdAt: createdAt as number,
    cwd: optionalString(parsed["cwd"], "cwd", sourcePath),
    parentSession: optionalString(parsed["parentSession"], "parentSession", sourcePath),
    seedLength: seedLength as number | undefined,
    origin: origin as "subagent" | undefined,
    delegationDepth: delegationDepth as number,
    agentPreset: optionalString(parsed["agentPreset"], "agentPreset", sourcePath),
  };
}

/** Validate the run-shared fields of a packed chunk row and return its members. */
function chunkRunMembers(
  data: Record<string, unknown>,
  payloadKey: "texts" | "args",
  tag: string,
  sourcePath: string,
): { members: string[]; gaps: number[] } {
  const malformed = (reason: string): never => {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: malformed ${tag} storage row: ${reason}`,
    );
  };
  if (
    typeof data["turn"] !== "number" ||
    typeof data["step"] !== "number" ||
    typeof data["index"] !== "number"
  ) {
    malformed("turn/step/index must be numbers");
  }
  const payload = data[payloadKey];
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    payload.some((entry) => typeof entry !== "string")
  ) {
    malformed(`${payloadKey} must be a non-empty string array`);
  }
  const gaps = data["dt"];
  if (!Array.isArray(gaps) || gaps.some((gap) => !Number.isSafeInteger(gap))) {
    malformed("dt must be an array of safe integers");
  }
  const members = payload as string[];
  if ((gaps as number[]).length !== members.length - 1) {
    malformed(`dt length ${(gaps as number[]).length} does not match ${members.length} members`);
  }
  return { members, gaps: gaps as number[] };
}

/**
 * Expand one packed chunk row back into the exact `assistant/chunk` events it
 * stores. A malformed row throws: treating it as a single opaque event would
 * silently drop an entire streaming run.
 */
function expandChunkRow(row: Record<string, unknown>, tag: string, sourcePath: string): DshEvent[] {
  const malformed = (reason: string): never => {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: malformed ${tag} storage row: ${reason}`,
    );
  };
  const seq0 = row["seq0"];
  const time0 = row["time0"];
  if (!isCount(seq0)) malformed("seq0 must be a non-negative safe integer");
  if (!Number.isSafeInteger(time0)) malformed("time0 must be a safe integer");
  const data = row["data"];
  if (!isRecord(data)) malformed("data must be an object");
  const payload = data as Record<string, unknown>;

  const isToolCall = tag === TOOL_CALL_CHUNK_ROW;
  const { members, gaps } = chunkRunMembers(
    payload,
    isToolCall ? "args" : "texts",
    tag,
    sourcePath,
  );
  const callId = payload["id"];
  const callName = payload["name"];
  if (isToolCall) {
    if (typeof callId !== "string") malformed("id must be a string");
    if (callName !== undefined && typeof callName !== "string") malformed("name must be a string");
  }
  if (!Number.isSafeInteger((seq0 as number) + members.length - 1)) {
    malformed("member seqs must stay safe integers");
  }

  const turn = payload["turn"] as number;
  const step = payload["step"] as number;
  const index = payload["index"] as number;
  const deltaType =
    tag === "text-chunks"
      ? "text-delta"
      : tag === "reasoning-chunks"
        ? "reasoning-delta"
        : "tool-call-delta";

  const events: DshEvent[] = [];
  let time = time0 as number;
  for (let member = 0; member < members.length; member += 1) {
    if (member > 0) {
      time += gaps[member - 1] as number;
      if (!Number.isSafeInteger(time)) malformed("member times must stay safe integers");
    }
    const chunk = isToolCall
      ? {
          type: deltaType,
          index,
          id: callId,
          ...(callName !== undefined ? { name: callName } : {}),
          argumentsDelta: members[member],
        }
      : { type: deltaType, index, text: members[member] };
    events.push({
      type: "assistant/chunk",
      seq: (seq0 as number) + member,
      time,
      data: { turn, step, chunk },
    });
  }
  return events;
}

/** Decode one storage record into the event(s) it holds, in log order. */
function decodeStorageRecord(line: string, sourcePath: string): DshEvent[] {
  const parsed = parseJsonRecord(line, "event record", sourcePath);
  const tag = parsed["type"];
  if (typeof tag === "string" && (TEXT_CHUNK_ROWS.has(tag) || tag === TOOL_CALL_CHUNK_ROW)) {
    return expandChunkRow(parsed, tag, sourcePath);
  }
  if (typeof tag !== "string" || tag.length === 0) {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: event record has no type`,
    );
  }
  if (!KNOWN_DSH_EVENT_TYPES.has(tag) && parsed["ignorable"] !== true) {
    throw new DshSessionLogError(
      `DSH session log ${JSON.stringify(sourcePath)} contains unsupported required event ` +
        `${JSON.stringify(tag)}; upgrade CodeSesh to read it`,
    );
  }
  if (!isCount(parsed["seq"]) || !Number.isSafeInteger(parsed["time"])) {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: event ${JSON.stringify(tag)} has an invalid seq/time`,
    );
  }
  return [parsed as unknown as DshEvent];
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * Read a log's authoritative identity without decoding its conversation, so
 * enumeration scales with the session count rather than total log size.
 *
 * The header is an immutable prefix that only a whole-file replacement can
 * change, and a replacement moves the fingerprint, so this read deliberately
 * skips the stable-snapshot handshake a full parse needs.
 */
export function readDshSessionHeader(sourcePath: string, encoding: DshEncoding): DshSessionHeader {
  const prefix = readFilePrefix(sourcePath, HEADER_PREFIX_BYTES);
  const line =
    firstRecordOf(prefix, sourcePath, encoding, prefix.length === HEADER_PREFIX_BYTES) ??
    firstRecordOf(readFileSync(sourcePath), sourcePath, encoding, false);
  return parseHeaderRecord(line as string, sourcePath);
}

/** The first record, or null when only a longer read could contain it. */
function firstRecordOf(
  buffer: Buffer,
  sourcePath: string,
  encoding: DshEncoding,
  mayBeTruncated: boolean,
): string | null {
  if (mayBeTruncated) {
    const complete =
      encoding === "zstd"
        ? scanZstdFrames(buffer, sourcePath, 1).frames.length > 0
        : buffer.includes(0x0a);
    if (!complete) return null;
  }
  return readRecords(buffer, sourcePath, encoding, true)[0] as string;
}

/**
 * Read the header and the contiguous event prefix a log can prove. Expanded
 * events must be densely numbered from zero: a gap, duplicate or rewind means
 * the source is corrupt, not merely incomplete.
 */
export function readDshSessionLog(sourcePath: string, encoding: DshEncoding): DshSessionLog {
  const { buffer } = readDshFileSnapshot(sourcePath);
  const records = readRecords(buffer, sourcePath, encoding, false);
  const header = parseHeaderRecord(records[0] as string, sourcePath);

  const events: DshEvent[] = [];
  for (let line = 1; line < records.length; line += 1) {
    for (const event of decodeStorageRecord(records[line] as string, sourcePath)) {
      if (event.seq !== events.length) {
        throw new DshSessionLogError(
          `corrupt DSH session log ${JSON.stringify(sourcePath)}: seq ${event.seq} at record ` +
            `${line} breaks the contiguous prefix (expected ${events.length})`,
        );
      }
      events.push(event);
    }
  }

  if (header.seedLength !== undefined && header.seedLength > events.length) {
    throw new DshSessionLogError(
      `corrupt DSH session log ${JSON.stringify(sourcePath)}: seedLength ${header.seedLength} ` +
        `exceeds ${events.length} events`,
    );
  }

  return { header, events };
}
