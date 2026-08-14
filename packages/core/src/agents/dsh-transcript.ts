/**
 * Projection from a DSH v0 event log onto CodeSesh's session contract.
 *
 * Three DSH distinctions drive everything here and have no CodeSesh equivalent
 * yet, so they are resolved during projection rather than shown raw:
 *
 * - `user/message` covers direct human prompts AND injected context (agent
 *   instructions, system-prompt snapshots, skill catalogs); only `source.kind
 *   === 'user'` is a human turn.
 * - the model-visible surface deliberately shadows compacted ranges, so a
 *   human transcript projects append-origin events only.
 * - a forked log carries its parent's history as an inherited seed prefix;
 *   counting it in the child would bill the same tokens once per descendant.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ImagePart,
  Message,
  MessagePart,
  MessageTokens,
  SessionStats,
  ToolPart,
} from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { normalizeTitleText } from "../utils/title-fallback.js";
import { DshSessionLogError, type DshEvent, type DshSessionHeader } from "./dsh-session-log.js";
import { TranscriptBuilder } from "./transcript-builder.js";

const AGENT_NAME = "dsh";

/** DSH's version-one attachment path accepts exactly these raster formats. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

const IMAGE_UNAVAILABLE_TEXT = "Image attachment unavailable";

export interface DshProjection {
  messages: Message[];
  stats: SessionStats;
  modelUsage: Record<string, number>;
  title: string | null;
  updatedAt: number;
}

interface UsageTotals {
  input: number;
  /** Raw DSH output tokens; reasoning is already included in it. */
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
}

/** Streaming state for one `(turn, step)` that has no settled message yet. */
interface PendingStep {
  turn: number;
  step: number;
  firstTime: number;
  lastTime: number;
  blocks: Map<number, PendingBlock>;
  usage: DshTokenUsage | null;
}

type PendingBlock =
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: string };

interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface ProjectionContext {
  sessionId: string;
  sourcePath: string;
  attachmentsRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function corrupt(context: ProjectionContext, reason: string): never {
  throw new DshSessionLogError(
    `corrupt DSH session log ${JSON.stringify(context.sourcePath)}: ${reason}`,
  );
}

function warn(context: ProjectionContext, event: string, detail: Record<string, unknown>): void {
  getCoreDiagnostics()?.warn(event, {
    agent: AGENT_NAME,
    session_id: context.sessionId,
    ...detail,
  });
}

// ---------------------------------------------------------------------------
// Surface placement
// ---------------------------------------------------------------------------

const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user/message",
  "assistant/message",
  "tool/result",
]);

/**
 * Classify how a surface-eligible event entered the model-visible surface.
 * Only `append` belongs in a human transcript: a replacement is a compaction
 * copy that shadows conversation the user already saw.
 */
function isAppendOrigin(event: DshEvent, context: ProjectionContext): boolean {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false;
  const op = event.surfaceOp;
  if (op === "append") return true;
  if (op === undefined) {
    corrupt(
      context,
      `surface event ${JSON.stringify(event.type)} at seq ${event.seq} has no surfaceOp`,
    );
  }
  const replace = asRecord(op);
  if (
    replace["op"] !== "replace" ||
    !Number.isSafeInteger(replace["start"]) ||
    !Number.isSafeInteger(replace["end"])
  ) {
    corrupt(
      context,
      `surface event ${JSON.stringify(event.type)} at seq ${event.seq} has an invalid surfaceOp`,
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/**
 * Load a content-addressed image and prove the bytes still match the durable
 * reference. The attachment id is matched against a strict `sha256:<hex>`
 * pattern and used only to derive the object path — never joined as a path.
 */
function readImageBlock(
  block: Record<string, unknown>,
  timeMs: number,
  context: ProjectionContext,
): ImagePart | null {
  const attachment = asRecord(block["attachment"]);
  const attachmentId = asText(attachment["attachmentId"]);
  const mediaType = asText(attachment["mediaType"]);
  const digest = ATTACHMENT_ID_PATTERN.exec(attachmentId)?.[1];

  const reject = (reason: string): null => {
    warn(context, "dsh.attachment_unreadable", { attachment_id: attachmentId, reason });
    return null;
  };

  if (!digest) return reject("invalid attachment reference");
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return reject("unsupported media type");

  let data: Buffer;
  try {
    data = readFileSync(join(context.attachmentsRoot, "objects", digest.slice(0, 2), digest));
  } catch {
    return reject("attachment object is missing");
  }
  const declaredBytes = attachment["bytes"];
  if (typeof declaredBytes === "number" && data.byteLength !== declaredBytes) {
    return reject("attachment byte length does not match its reference");
  }
  if (createHash("sha256").update(data).digest("hex") !== digest) {
    return reject("attachment failed integrity verification");
  }

  return {
    type: "image",
    data: data.toString("base64"),
    mime_type: mediaType,
    time_created: timeMs,
  };
}

/**
 * Convert DSH content blocks into CodeSesh parts. `tool-call` blocks are
 * skipped when a canonical `tool/call` event carries the same call: the two
 * describe one invocation and rendering both would duplicate the tool card.
 */
function convertContentBlocks(
  content: unknown,
  timeMs: number,
  context: ProjectionContext,
  canonicalCallIds: ReadonlySet<string>,
): MessagePart[] {
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  let droppedImages = 0;

  for (const raw of content) {
    const block = asRecord(raw);
    switch (block["type"]) {
      case "text":
      case "reasoning": {
        const text = cleanInternalText(asText(block["text"]));
        if (text) parts.push({ type: block["type"], text, time_created: timeMs });
        break;
      }
      case "image": {
        const image = readImageBlock(block, timeMs, context);
        if (image) parts.push(image);
        else droppedImages += 1;
        break;
      }
      case "tool-call": {
        const callId = asText(block["id"]);
        if (callId && canonicalCallIds.has(callId)) break;
        parts.push(buildToolPart(callId, asText(block["name"]), block["arguments"], timeMs));
        break;
      }
      default:
        break;
    }
  }

  // A message whose only content was an unreadable image must keep its place
  // in the timeline rather than vanish from the conversation.
  if (parts.length === 0 && droppedImages > 0) {
    parts.push({ type: "text", text: IMAGE_UNAVAILABLE_TEXT, time_created: timeMs });
  }
  return parts;
}

/** Raw arguments stay verbatim when unparsable so an interrupted call is still diagnosable. */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildToolPart(
  callId: string,
  name: string,
  rawArguments: unknown,
  timeMs: number,
): ToolPart {
  const tool = name.trim() || "tool";
  return {
    type: "tool",
    tool,
    title: tool.toLowerCase(),
    callID: callId || undefined,
    time_created: timeMs,
    state: { status: "running", input: parseToolArguments(rawArguments) },
  };
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readUsage(value: unknown): DshTokenUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: nonNegative(value["inputTokens"]),
    outputTokens: nonNegative(value["outputTokens"]),
    cacheReadTokens: nonNegative(value["cacheReadTokens"]),
    cacheWriteTokens: nonNegative(value["cacheWriteTokens"]),
    reasoningTokens: nonNegative(value["reasoningTokens"]),
  };
}

/**
 * DSH input buckets are disjoint (`inputTokens` is uncached input, cache reads
 * and writes are separate) and reasoning is already inside `outputTokens`.
 * CodeSesh prices a total input and a visible output separately, so the buckets
 * are folded in and reasoning is split out — counting either twice would
 * inflate both the token totals and the estimated cost.
 */
function toMessageTokens(usage: DshTokenUsage): { tokens: MessageTokens; totals: UsageTotals } {
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheCreate = nonNegative(usage.cacheWriteTokens);
  const totalInput = nonNegative(usage.inputTokens) + cacheRead + cacheCreate;
  const output = nonNegative(usage.outputTokens);
  const reasoning = Math.min(nonNegative(usage.reasoningTokens), output);

  return {
    tokens: {
      input: totalInput,
      output: output - reasoning,
      reasoning: reasoning || undefined,
      cache_read: cacheRead || undefined,
      cache_create: cacheCreate || undefined,
    },
    totals: { input: totalInput, output, cacheRead, cacheCreate, cost: 0 },
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

class DshProjector {
  private readonly builder = new TranscriptBuilder({ messageDefaults: "sparse" });
  private readonly totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cost: 0,
  };
  private readonly modelUsage: Record<string, number> = {};
  private readonly settledSteps = new Set<string>();
  private pending: PendingStep | null = null;
  private provider: string | null = null;
  private model: string | null = null;
  private ownTitle: string | null = null;
  private inheritedTitle: string | null = null;
  private subagentLabel: string | null = null;
  private firstHumanText: string | null = null;
  private updatedAt = 0;

  constructor(
    private readonly context: ProjectionContext,
    private readonly seedLength: number,
    private readonly canonicalCallIds: ReadonlySet<string>,
  ) {}

  project(events: readonly DshEvent[]): DshProjection {
    for (const event of events) {
      const own = event.seq >= this.seedLength;
      if (own) this.updatedAt = Math.max(this.updatedAt, event.time);
      this.consume(event, own);
    }
    this.flushPendingStep();

    const result = this.builder.finish({
      message_count: 0,
      total_input_tokens: this.totals.input,
      total_output_tokens: this.totals.output,
      total_cache_read_tokens: this.totals.cacheRead || undefined,
      total_cache_create_tokens: this.totals.cacheCreate || undefined,
      total_cost: this.totals.cost,
      cost_source: this.totals.cost > 0 ? "estimated" : undefined,
    });

    return {
      messages: result.messages,
      stats: result.stats,
      modelUsage: this.modelUsage,
      title: this.resolveTitle(),
      updatedAt: this.updatedAt,
    };
  }

  private consume(event: DshEvent, own: boolean): void {
    switch (event.type) {
      case "user/message":
        this.consumeUserMessage(event, own);
        return;
      case "assistant/message":
        this.consumeAssistantMessage(event, own);
        return;
      case "tool/call":
        if (own) this.consumeToolCall(event);
        return;
      case "tool/result":
        if (isAppendOrigin(event, this.context) && own) this.consumeToolResult(event);
        return;
      case "assistant/chunk":
        if (own) this.consumeChunk(event);
        return;
      case "request/context":
        this.consumeRequestContext(event);
        return;
      case "session/title":
        this.consumeTitle(event, own);
        return;
      case "subagent/descriptor":
        if (own) this.consumeSubagentDescriptor(event);
        return;
      default:
        return;
    }
  }

  private consumeUserMessage(event: DshEvent, own: boolean): void {
    // Every user/message is validated for surface placement, but injected
    // context and compaction replacements never become human turns.
    const appendOrigin = isAppendOrigin(event, this.context);
    const data = asRecord(event.data);
    if (!appendOrigin || !own || asRecord(data["source"])["kind"] !== "user") return;

    const parts = convertContentBlocks(
      data["content"],
      event.time,
      this.context,
      this.canonicalCallIds,
    );
    if (parts.length === 0) return;
    this.builder.appendMessage({
      id: asText(data["id"]) || `dsh-user-${event.seq}`,
      role: "user",
      timestampMs: event.time,
      parts,
    });
    // Read the title candidate from the source blocks, so an unreadable-image
    // placeholder never becomes the session's name.
    this.firstHumanText ??= firstTextBlock(data["content"]);
  }

  private consumeAssistantMessage(event: DshEvent, own: boolean): void {
    const appendOrigin = isAppendOrigin(event, this.context);
    const data = asRecord(event.data);
    const turn = data["turn"];
    const step = data["step"];
    if (typeof turn === "number" && typeof step === "number") {
      this.settleStep(turn, step);
    }
    if (!appendOrigin || !own) return;

    const message = asRecord(data["message"]);
    const source = asRecord(message["source"]);
    const provider = asText(source["provider"]) || null;
    const model = asText(source["model"]) || null;
    if (provider) this.provider = provider;
    if (model) this.model = model;

    const parts = convertContentBlocks(
      message["content"],
      event.time,
      this.context,
      this.canonicalCallIds,
    );
    const usage = readUsage(data["usage"]);
    this.appendAssistant({
      id: asText(message["id"]) || `dsh-assistant-${event.seq}`,
      timeMs: event.time,
      parts,
      provider,
      model,
      usage,
    });
  }

  private consumeToolCall(event: DshEvent): void {
    const data = asRecord(event.data);
    const callId = asText(data["callId"]);
    const part = buildToolPart(callId, asText(data["name"]), data["arguments"], event.time);
    this.builder.appendToolCall(
      part,
      { id: callId, timestampMs: event.time, agent: AGENT_NAME },
      { target: "current" },
    );
  }

  private consumeToolResult(event: DshEvent): void {
    const data = asRecord(event.data);
    const message = asRecord(data["message"]);
    const source = asRecord(message["source"]);
    if (source["kind"] !== "tool") {
      corrupt(this.context, `tool/result at seq ${event.seq} is not sourced from a tool call`);
    }
    const callId = asText(source["callId"]);
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const block = asRecord(content[0]);
    if (content.length !== 1 || block["type"] !== "tool-result") {
      corrupt(
        this.context,
        `tool/result at seq ${event.seq} must carry exactly one tool-result block`,
      );
    }
    if (asText(block["toolCallId"]) !== callId) {
      corrupt(this.context, `tool/result at seq ${event.seq} disagrees with its call identity`);
    }

    const failed = block["isError"] === true || isRecord(data["error"]);
    const resolved = this.builder.resolveToolCall(callId, {
      output: convertContentBlocks(
        block["content"],
        event.time,
        this.context,
        this.canonicalCallIds,
      ),
      status: failed ? "error" : "completed",
      metadata: data["meta"],
      consume: true,
    });
    if (!resolved) {
      warn(this.context, "dsh.orphan_tool_result", { call_id: callId, seq: event.seq });
    }
  }

  private consumeChunk(event: DshEvent): void {
    const data = asRecord(event.data);
    const turn = data["turn"];
    const step = data["step"];
    if (typeof turn !== "number" || typeof step !== "number") return;
    if (this.settledSteps.has(stepKey(turn, step))) return;

    const pending = this.openStep(turn, step, event.time);
    pending.lastTime = event.time;
    applyChunk(pending, asRecord(data["chunk"]));
  }

  private consumeRequestContext(event: DshEvent): void {
    const data = asRecord(event.data);
    const provider = asText(data["provider"]);
    const model = asText(data["model"]);
    if (provider) this.provider = provider;
    if (model) this.model = model;
  }

  private consumeTitle(event: DshEvent, own: boolean): void {
    const title = normalizeTitleText(asText(asRecord(event.data)["title"]));
    if (!title) return;
    if (own) this.ownTitle = title;
    else this.inheritedTitle = title;
  }

  private consumeSubagentDescriptor(event: DshEvent): void {
    const label = normalizeTitleText(asText(asRecord(event.data)["label"]));
    if (label) this.subagentLabel ??= label;
  }

  /** A settled message supersedes the streaming deltas of the same step. */
  private settleStep(turn: number, step: number): void {
    this.settledSteps.add(stepKey(turn, step));
    if (this.pending?.turn === turn && this.pending.step === step) this.pending = null;
  }

  private openStep(turn: number, step: number, timeMs: number): PendingStep {
    if (this.pending && (this.pending.turn !== turn || this.pending.step !== step)) {
      this.flushPendingStep();
    }
    this.pending ??= {
      turn,
      step,
      firstTime: timeMs,
      lastTime: timeMs,
      blocks: new Map(),
      usage: null,
    };
    return this.pending;
  }

  /** Rebuild the assistant message of a step the log was cut short in. */
  private flushPendingStep(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;

    const parts: MessagePart[] = [];
    for (const index of [...pending.blocks.keys()].sort((a, b) => a - b)) {
      const block = pending.blocks.get(index) as PendingBlock;
      if (block.type === "tool-call") {
        if (this.canonicalCallIds.has(block.id)) continue;
        parts.push(buildToolPart(block.id, block.name, block.args, pending.lastTime));
        continue;
      }
      const text = cleanInternalText(block.text);
      if (text) parts.push({ type: block.type, text, time_created: pending.firstTime });
    }
    if (parts.length === 0) return;

    this.appendAssistant({
      id: `dsh-step-${pending.turn}-${pending.step}`,
      timeMs: pending.firstTime,
      parts,
      provider: this.provider,
      model: this.model,
      usage: pending.usage,
    });
  }

  private appendAssistant(input: {
    id: string;
    timeMs: number;
    parts: MessagePart[];
    provider: string | null;
    model: string | null;
    usage: DshTokenUsage | null;
  }): void {
    const mapped = input.usage ? toMessageTokens(input.usage) : null;
    const cost = mapped ? (estimateTokenCost(input.model, mapped.tokens) ?? 0) : 0;

    if (mapped) {
      this.totals.input += mapped.totals.input;
      this.totals.output += mapped.totals.output;
      this.totals.cacheRead += mapped.totals.cacheRead;
      this.totals.cacheCreate += mapped.totals.cacheCreate;
      this.totals.cost += cost;
      if (input.model) {
        const billed = mapped.totals.input + mapped.totals.output;
        this.modelUsage[input.model] = (this.modelUsage[input.model] ?? 0) + billed;
      }
    }

    // An empty-content assistant/message exists only to host a step's usage;
    // its tokens are real spend even though it shows nothing.
    if (input.parts.length === 0) return;

    this.builder.appendMessage({
      id: input.id,
      role: "assistant",
      agent: AGENT_NAME,
      timestampMs: input.timeMs,
      parts: input.parts,
      provider: input.provider,
      model: input.model,
      tokens: mapped?.tokens,
      cost: cost || undefined,
      costSource: cost > 0 ? "estimated" : undefined,
    });
  }

  private resolveTitle(): string | null {
    return this.ownTitle ?? this.subagentLabel ?? this.firstHumanText ?? this.inheritedTitle;
  }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function firstTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block["type"] !== "text") continue;
    const text = cleanInternalText(asText(block["text"]));
    if (text) return text;
  }
  return null;
}

/** Fold one stream chunk into the pending step's per-block accumulators. */
function applyChunk(pending: PendingStep, chunk: Record<string, unknown>): void {
  const index = chunk["index"];
  if (typeof index !== "number") {
    if (chunk["type"] === "usage") pending.usage = readUsage(chunk["usage"]);
    return;
  }

  switch (chunk["type"]) {
    case "text-delta":
    case "reasoning-delta": {
      const type = chunk["type"] === "text-delta" ? "text" : "reasoning";
      const current = pending.blocks.get(index);
      const text = current && current.type === type ? current.text : "";
      pending.blocks.set(index, { type, text: text + asText(chunk["text"]) });
      return;
    }
    case "tool-call-delta": {
      const current = pending.blocks.get(index);
      const args = current && current.type === "tool-call" ? current.args : "";
      const name = current && current.type === "tool-call" ? current.name : "";
      pending.blocks.set(index, {
        type: "tool-call",
        id: asText(chunk["id"]),
        name: asText(chunk["name"]) || name,
        args: args + asText(chunk["argumentsDelta"]),
      });
      return;
    }
    case "block-end": {
      // The assembled block is authoritative over the deltas that built it.
      const block = asRecord(chunk["block"]);
      if (block["type"] === "text" || block["type"] === "reasoning") {
        pending.blocks.set(index, { type: block["type"], text: asText(block["text"]) });
      } else if (block["type"] === "tool-call") {
        pending.blocks.set(index, {
          type: "tool-call",
          id: asText(block["id"]),
          name: asText(block["name"]),
          args: asText(block["arguments"]),
        });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Collect the canonical call ids so an assistant message's `tool-call` blocks
 * can defer to them. A duplicate id is source corruption: two invocations
 * sharing an id make every result ambiguous.
 */
function collectCanonicalCallIds(
  events: readonly DshEvent[],
  context: ProjectionContext,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const callId = asText(asRecord(event.data)["callId"]);
    if (!callId) corrupt(context, `tool/call at seq ${event.seq} has no call id`);
    if (ids.has(callId)) corrupt(context, `duplicate tool call id ${JSON.stringify(callId)}`);
    ids.add(callId);
  }
  return ids;
}

/**
 * Project a DSH log onto CodeSesh messages, stats and title.
 *
 * `updatedAt` and every token total cover the session's own suffix only; the
 * inherited seed prefix still validates, but belongs to the parent.
 */
export function projectDshSession(options: {
  header: DshSessionHeader;
  events: readonly DshEvent[];
  sourcePath: string;
  attachmentsRoot: string;
}): DshProjection {
  const context: ProjectionContext = {
    sessionId: options.header.id,
    sourcePath: options.sourcePath,
    attachmentsRoot: options.attachmentsRoot,
  };
  const projector = new DshProjector(
    context,
    options.header.seedLength ?? 0,
    collectCanonicalCallIds(options.events, context),
  );
  const projection = projector.project(options.events);
  return {
    ...projection,
    updatedAt: projection.updatedAt || options.header.createdAt,
  };
}
