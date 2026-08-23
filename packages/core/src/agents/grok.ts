import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import {
  FileSystemSessionSource,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  skippedSession,
  type AgentScanOptions,
  type FileSessionMeta,
  type ParseSessionResult,
  type SessionSourceFile,
  type SessionSourceRef,
} from "./base.js";
import type {
  Message,
  MessagePart,
  MessageTokens,
  PlanPart,
  SessionDetail,
  SessionHead,
  SessionStats,
  ToolPart,
  ToolPartStatus,
} from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { asArray, asNumber, asRecord, asString } from "../utils/narrow.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { basenameTitle, resolveSessionTitle } from "../utils/title-fallback.js";
import { TranscriptBuilder, type TranscriptResult } from "./transcript-builder.js";

const HEAD_INDEX_VERSION = "grok-head-v2";
const PARSER_VERSION = "grok-parser-v1";
const SUMMARY_FILE = "summary.json";
const UPDATES_FILE = "updates.jsonl";
const ACP_UPDATE_METHOD = "session/update";
const XAI_UPDATE_METHOD = "_x.ai/session/update";
const USD_TICKS_PER_USD = 10_000_000_000;

const GROK_TOOL_TITLE_MAP: Record<string, string> = {
  get_command_or_subagent_output: "task",
  grep: "grep",
  list_dir: "list",
  read_file: "read",
  run_terminal_command: "bash",
  search_replace: "edit",
  todo_write: "todo",
  web_fetch: "web fetch",
};

interface GrokSummary {
  id: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  currentModel: string | null;
  parentSessionId: string | null;
}

interface GrokSessionMeta extends FileSessionMeta {
  currentModel: string | null;
  parentSessionId: string | null;
  updatesPath: string | null;
  stats: SessionStats;
}

interface GrokUpdate {
  method: string;
  params: Record<string, unknown>;
  update: Record<string, unknown>;
  timestampMs: number;
}

interface GrokUsage {
  tokens: MessageTokens;
  totalTokens: number;
  cost: number | null;
  modelUsage: Record<string, number>;
  primaryModel: string | null;
}

interface GrokHeadData {
  firstUserText: string | null;
  visibleMessageCount: number;
  stats: Omit<SessionStats, "message_count">;
  modelUsage: Record<string, number>;
}

export function resolveGrokDataRoot(): string {
  return resolveHomePath("GROK_HOME", ".grok");
}

function safeCount(value: unknown): number {
  const number = asNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function addCount(total: number, value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + value);
}

function timestampFromIso(value: unknown): number | null {
  const text = asString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(filePath, "utf8"))) ?? null;
  } catch {
    return null;
  }
}

function parseSummary(source: SessionSourceFile): GrokSummary | null {
  const summary = readJsonRecord(source.file);
  const info = asRecord(summary?.info);
  const id = asString(info?.id)?.trim();
  const cwd = asString(info?.cwd)?.trim();
  if (!id || !cwd) return null;

  const createdAt = timestampFromIso(summary?.created_at) ?? source.stat.mtimeMs;
  const updatedAt =
    timestampFromIso(summary?.last_active_at) ?? timestampFromIso(summary?.updated_at) ?? createdAt;
  const generatedTitle = asString(summary?.generated_title)?.trim();
  const sessionSummary = asString(summary?.session_summary)?.trim();
  const parentSessionId = asString(summary?.parent_session_id)?.trim() || null;

  return {
    id,
    cwd,
    title: generatedTitle || sessionSummary || null,
    createdAt,
    updatedAt,
    currentModel: asString(summary?.current_model_id)?.trim() || null,
    parentSessionId: parentSessionId === id ? null : parentSessionId,
  };
}

function optionalFileFingerprint(filePath: string): [number, number] | null {
  try {
    const stat = statSync(filePath);
    return [stat.mtimeMs, stat.size];
  } catch {
    return null;
  }
}

function unpackUpdate(
  record: Record<string, unknown>,
  fallbackTimestampMs: number,
): GrokUpdate | null {
  const method = asString(record.method) ?? ACP_UPDATE_METHOD;
  const params = asRecord(record.params) ?? record;
  const update = asRecord(params.update);
  if (!update) return null;

  const paramsMeta = asRecord(params._meta);
  const agentTimestampMs = asNumber(paramsMeta?.agentTimestampMs);
  const envelopeTimestamp = asNumber(record.timestamp);
  const timestampMs =
    agentTimestampMs !== undefined &&
    Number.isSafeInteger(agentTimestampMs) &&
    agentTimestampMs >= 0
      ? agentTimestampMs
      : envelopeTimestamp !== undefined &&
          Number.isSafeInteger(envelopeTimestamp) &&
          envelopeTimestamp >= 0 &&
          envelopeTimestamp <= Number.MAX_SAFE_INTEGER / 1000
        ? envelopeTimestamp * 1000
        : fallbackTimestampMs;

  return { method, params, update, timestampMs };
}

function isHostTurn(update: Record<string, unknown>): boolean {
  return asRecord(update._meta)?.hostTurn === true;
}

function updateType(update: GrokUpdate): string {
  return asString(update.update.sessionUpdate) ?? "";
}

function parseUsage(update: Record<string, unknown>): GrokUsage | null {
  const usage = asRecord(update.usage);
  if (!usage) return null;

  const input = safeCount(usage.inputTokens);
  const output = safeCount(usage.outputTokens);
  const reasoning = safeCount(usage.reasoningTokens);
  const cacheRead = safeCount(usage.cachedReadTokens);
  const cacheCreate = safeCount(usage.cacheCreationTokens);
  const totalTokens = safeCount(usage.totalTokens) || addCount(input, output);
  const isIncomplete = usage.usageIsIncomplete === true || usage.costIsPartial === true;
  const costTicks = safeCount(usage.costUsdTicks);
  const cost = !isIncomplete && costTicks > 0 ? costTicks / USD_TICKS_PER_USD : null;

  const modelUsage: Record<string, number> = {};
  const modelUsageRecord = asRecord(usage.modelUsage);
  if (modelUsageRecord) {
    for (const [model, rawUsage] of Object.entries(modelUsageRecord)) {
      const modelRecord = asRecord(rawUsage);
      if (!modelRecord) continue;
      const modelTotal =
        safeCount(modelRecord.totalTokens) ||
        addCount(safeCount(modelRecord.inputTokens), safeCount(modelRecord.outputTokens));
      if (modelTotal > 0) modelUsage[model] = modelTotal;
    }
  }

  const models = Object.keys(modelUsage);
  return {
    tokens: {
      input,
      output,
      reasoning: reasoning || undefined,
      cache_read: cacheRead || undefined,
      cache_create: cacheCreate || undefined,
    },
    totalTokens,
    cost,
    modelUsage,
    primaryModel: models.length === 1 ? models[0]! : null,
  };
}

function textFromContentBlock(value: unknown): string {
  const content = asRecord(value);
  if (!content) return "";
  if (content.type === "text") return asString(content.text) ?? "";
  const resource = asRecord(content.resource);
  return asString(resource?.text) ?? "";
}

function messagePartFromContentBlock(value: unknown, timestampMs: number): MessagePart | null {
  const content = asRecord(value);
  if (!content) return null;

  if (content.type === "text") {
    const text = asString(content.text) ?? "";
    return text ? { type: "text", text, time_created: timestampMs } : null;
  }

  if (content.type === "image") {
    const data = asString(content.data);
    const url = asString(content.uri) ?? asString(content.url);
    const mimeType = asString(content.mimeType) ?? asString(content.mime_type);
    if (data && mimeType) {
      return { type: "image", data, mime_type: mimeType, url, time_created: timestampMs };
    }
    if (url) return { type: "image", url, mime_type: mimeType, time_created: timestampMs };
  }

  const text = textFromContentBlock(content);
  return text ? { type: "text", text, time_created: timestampMs } : null;
}

function visibleMessagePartFromContentBlock(
  value: unknown,
  timestampMs: number,
): MessagePart | null {
  const part = messagePartFromContentBlock(value, timestampMs);
  if (part?.type === "text" && !cleanInternalText(part.text)) return null;
  return part;
}

type GrokMessageTransition = "ignored" | "started" | "continued";

type ActiveGrokMessage =
  | { role: "user"; promptIndex: number | null }
  | { role: "assistant"; promptId: string | null };

class GrokMessageGrouping {
  private active: ActiveGrokMessage | null = null;

  appendUser(envelope: GrokUpdate, hasVisibleContent: boolean): GrokMessageTransition {
    if (isHostTurn(envelope.update) || !hasVisibleContent) return "ignored";

    const promptIndexValue = asNumber(asRecord(envelope.update._meta)?.promptIndex);
    const promptIndex =
      promptIndexValue !== undefined && Number.isSafeInteger(promptIndexValue)
        ? promptIndexValue
        : null;
    const canReuse =
      this.active?.role === "user" &&
      (promptIndex === null ||
        this.active.promptIndex === null ||
        promptIndex === this.active.promptIndex);

    this.active = { role: "user", promptIndex };
    return canReuse ? "continued" : "started";
  }

  appendAssistant(envelope: GrokUpdate, hasVisibleContent: boolean): GrokMessageTransition {
    if (!hasVisibleContent) return "ignored";

    const promptId = asString(asRecord(envelope.params._meta)?.promptId)?.trim() || null;
    const canReuse =
      this.active?.role === "assistant" &&
      !(promptId && this.active.promptId && promptId !== this.active.promptId);
    const activePromptId =
      promptId || (this.active?.role === "assistant" ? this.active.promptId : null);

    this.active = { role: "assistant", promptId: activePromptId };
    return canReuse ? "continued" : "started";
  }
}

class GrokMessageCounter {
  firstUserText: string | null = null;
  messageCount = 0;
  private readonly grouping = new GrokMessageGrouping();

  process(envelope: GrokUpdate): void {
    if (envelope.method === XAI_UPDATE_METHOD) return;

    switch (updateType(envelope)) {
      case "user_message_chunk":
        this.appendUser(envelope);
        break;
      case "agent_thought_chunk":
      case "agent_message_chunk":
        this.appendAssistant(
          envelope,
          Boolean(cleanInternalText(textFromContentBlock(envelope.update.content))),
        );
        break;
      case "tool_call":
        this.appendAssistant(envelope, Boolean(asString(envelope.update.toolCallId)?.trim()));
        break;
      case "plan":
        this.appendAssistant(envelope, Boolean(planPart(envelope.update, envelope.timestampMs)));
        break;
    }
  }

  private appendUser(envelope: GrokUpdate): void {
    const part = visibleMessagePartFromContentBlock(envelope.update.content, envelope.timestampMs);
    const transition = this.grouping.appendUser(envelope, part !== null);
    if (!part || transition === "ignored") return;
    if (transition === "started") this.messageCount += 1;

    if (this.firstUserText === null && part.type === "text") {
      this.firstUserText = cleanInternalText(part.text) || null;
    }
  }

  private appendAssistant(envelope: GrokUpdate, hasVisibleContent: boolean): void {
    if (this.grouping.appendAssistant(envelope, hasVisibleContent) === "started") {
      this.messageCount += 1;
    }
  }
}

function scanCanonicalMessages(updatesPath: string, fallbackTimestampMs: number) {
  const rewindIndex = new RewindIndex();
  let recordIndex = 0;
  for (const record of readJsonlFile(updatesPath)) {
    rewindIndex.process(record, recordIndex, fallbackTimestampMs);
    recordIndex += 1;
  }

  const survivingIndexes = new Set(rewindIndex.survivingRecordIndexes);
  const counter = new GrokMessageCounter();
  recordIndex = 0;
  for (const record of readJsonlFile(updatesPath)) {
    if (survivingIndexes.has(recordIndex)) {
      const envelope = unpackUpdate(record, fallbackTimestampMs);
      if (envelope) counter.process(envelope);
    }
    recordIndex += 1;
  }
  return counter;
}

function scanHeadData(updatesPath: string | null, fallbackTimestampMs: number): GrokHeadData {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreateTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let hasUnknownCost = false;
  let hasRewinds = false;
  const modelUsage: Record<string, number> = {};
  let messageCounter = new GrokMessageCounter();

  if (updatesPath && existsSync(updatesPath)) {
    for (const line of readJsonlFileLines(updatesPath)) {
      const affectsMessages =
        line.includes('"user_message_chunk"') ||
        line.includes('"agent_thought_chunk"') ||
        line.includes('"agent_message_chunk"') ||
        line.includes('"tool_call"') ||
        line.includes('"plan"');
      const isTurnCompleted = line.includes('"turn_completed"');
      const isRewind = line.includes('"rewind_marker"');
      if (!affectsMessages && !isTurnCompleted && !isRewind) continue;

      let record: Record<string, unknown>;
      try {
        record = asRecord(JSON.parse(line)) ?? {};
      } catch {
        continue;
      }
      const envelope = unpackUpdate(record, fallbackTimestampMs);
      if (!envelope) continue;
      const type = updateType(envelope);
      if (affectsMessages) messageCounter.process(envelope);
      if (envelope.method === XAI_UPDATE_METHOD && type === "rewind_marker") {
        hasRewinds = true;
      }

      if (envelope.method !== XAI_UPDATE_METHOD || type !== "turn_completed") continue;
      const usage = parseUsage(envelope.update);
      if (!usage) continue;

      totalInputTokens = addCount(totalInputTokens, usage.tokens.input ?? 0);
      totalOutputTokens = addCount(totalOutputTokens, usage.tokens.output ?? 0);
      totalCacheReadTokens = addCount(totalCacheReadTokens, usage.tokens.cache_read ?? 0);
      totalCacheCreateTokens = addCount(totalCacheCreateTokens, usage.tokens.cache_create ?? 0);
      totalTokens = addCount(totalTokens, usage.totalTokens);
      if (usage.cost === null && usage.totalTokens > 0) hasUnknownCost = true;
      else totalCost += usage.cost ?? 0;

      for (const [model, tokens] of Object.entries(usage.modelUsage)) {
        modelUsage[model] = addCount(modelUsage[model] ?? 0, tokens);
      }
    }

    if (hasRewinds) messageCounter = scanCanonicalMessages(updatesPath, fallbackTimestampMs);
  }

  return {
    firstUserText: messageCounter.firstUserText,
    visibleMessageCount: messageCounter.messageCount,
    stats: {
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cache_read_tokens: totalCacheReadTokens || undefined,
      total_cache_create_tokens: totalCacheCreateTokens || undefined,
      total_tokens: totalTokens || addCount(totalInputTokens, totalOutputTokens),
      total_cost: totalCost,
      cost_source: totalCost > 0 && !hasUnknownCost ? "recorded" : undefined,
    },
    modelUsage,
  };
}

function toolTitle(toolName: string): string {
  return GROK_TOOL_TITLE_MAP[toolName] ?? toolName;
}

function toolStatus(value: unknown): ToolPartStatus | null {
  switch (asString(value)?.toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "in_progress":
    case "pending":
      return "running";
    default:
      return null;
  }
}

function toolOutput(update: Record<string, unknown>): unknown {
  if (update.rawOutput !== undefined && update.rawOutput !== null) return update.rawOutput;
  const content = asArray(update.content);
  if (!content) return undefined;

  const texts = content.flatMap((item) => {
    const wrapper = asRecord(item);
    const block = wrapper?.type === "content" ? wrapper.content : item;
    const text = textFromContentBlock(block);
    return text ? [text] : [];
  });
  if (texts.length === 0) return content;
  return texts.join("\n");
}

function planPart(update: Record<string, unknown>, timestampMs: number): PlanPart | null {
  const entries = asArray(update.entries)?.flatMap((value) => {
    const entry = asRecord(value);
    const content = cleanInternalText(asString(entry?.content) ?? "");
    if (!entry || !content) return [];
    return [{ content, status: asString(entry.status) ?? "pending" }];
  });
  if (!entries || entries.length === 0) return null;

  const text = entries
    .map(({ content, status }) => `- [${status === "completed" ? "x" : " "}] ${content}`)
    .join("\n");
  return {
    type: "plan",
    text,
    approval_status: entries.every(({ status }) => status === "completed") ? "success" : "fail",
    time_created: timestampMs,
  };
}

class GrokTranscriptReducer {
  private readonly builder = new TranscriptBuilder();
  private readonly grouping = new GrokMessageGrouping();
  private activeAssistant: Message | null = null;
  private activeUser: Message | null = null;
  private latestPlan: PlanPart | null = null;
  private currentMode: string | null = null;
  private currentModel: string | null;

  constructor(
    private readonly sessionId: string,
    currentModel: string | null,
    private readonly fallbackTimestampMs: number,
  ) {
    this.currentModel = currentModel;
  }

  process(record: Record<string, unknown>): void {
    const envelope = unpackUpdate(record, this.fallbackTimestampMs);
    if (!envelope) return;
    if (envelope.method === XAI_UPDATE_METHOD) {
      this.processXaiUpdate(envelope);
      return;
    }
    this.processAcpUpdate(envelope);
  }

  finish(stats: SessionStats): TranscriptResult {
    return this.builder.finish(stats);
  }

  private processAcpUpdate(envelope: GrokUpdate): void {
    switch (updateType(envelope)) {
      case "user_message_chunk":
        this.appendUserChunk(envelope);
        break;
      case "agent_thought_chunk":
        this.appendAssistantText(envelope, "reasoning");
        break;
      case "agent_message_chunk":
        this.appendAssistantText(envelope, "text");
        break;
      case "tool_call":
        this.appendToolCall(envelope);
        break;
      case "tool_call_update":
        this.updateToolCall(envelope);
        break;
      case "plan":
        this.updatePlan(envelope);
        break;
      case "current_mode_update":
        this.currentMode = asString(envelope.update.currentModeId)?.trim() || null;
        break;
    }
  }

  private processXaiUpdate(envelope: GrokUpdate): void {
    switch (updateType(envelope)) {
      case "turn_completed": {
        const usage = parseUsage(envelope.update);
        if (!usage) return;
        this.builder.attachUsageToLatestAssistant(usage.tokens, {
          model: usage.primaryModel ?? this.currentModel,
          cost: usage.cost ?? undefined,
          costSource: usage.cost === null ? undefined : "recorded",
        });
        return;
      }
      case "model_changed":
        this.currentModel = asString(envelope.update.model_id)?.trim() || this.currentModel;
        return;
      case "model_auto_switched":
        this.currentModel = asString(envelope.update.new_model_id)?.trim() || this.currentModel;
        return;
      case "subagent_spawned": {
        const childSessionId = asString(envelope.update.child_session_id)?.trim();
        if (childSessionId && this.activeAssistant && !this.activeAssistant.subagent_id) {
          this.activeAssistant.subagent_id = childSessionId;
        }
      }
    }
  }

  private appendUserChunk(envelope: GrokUpdate): void {
    const part = visibleMessagePartFromContentBlock(envelope.update.content, envelope.timestampMs);
    const transition = this.grouping.appendUser(envelope, part !== null);
    if (!part || transition === "ignored") return;

    if (transition === "continued") {
      const tail = this.activeUser!.parts.at(-1);
      if (tail?.type === "text" && part.type === "text") tail.text += part.text;
      else this.activeUser!.parts.push(part);
    } else {
      const eventId = asString(asRecord(envelope.params._meta)?.eventId);
      this.activeUser = this.builder.appendMessage({
        id: eventId || `${this.sessionId}-user-${envelope.timestampMs}`,
        role: "user",
        timestampMs: envelope.timestampMs,
        parts: [part],
      });
    }

    this.activeAssistant = null;
    this.latestPlan = null;
  }

  private prepareAssistant(envelope: GrokUpdate, hasVisibleContent: boolean): boolean {
    const transition = this.grouping.appendAssistant(envelope, hasVisibleContent);
    if (transition === "ignored") return false;
    if (transition === "started") {
      this.builder.beginTurn();
      this.activeAssistant = null;
      this.latestPlan = null;
    }
    this.activeUser = null;
    return true;
  }

  private assistantInput(envelope: GrokUpdate) {
    const paramsMeta = asRecord(envelope.params._meta);
    return {
      id:
        asString(paramsMeta?.promptId) ||
        asString(paramsMeta?.eventId) ||
        `${this.sessionId}-assistant-${envelope.timestampMs}`,
      timestampMs: envelope.timestampMs,
      agent: "grok",
      mode: this.currentMode,
      model: this.currentModel,
      provider: "xai",
    };
  }

  private appendAssistantText(envelope: GrokUpdate, type: "text" | "reasoning"): void {
    const text = textFromContentBlock(envelope.update.content);
    if (!this.prepareAssistant(envelope, Boolean(cleanInternalText(text)))) return;

    const tail = this.activeAssistant?.parts.at(-1);
    if (tail?.type === type) {
      tail.text += text;
      return;
    }

    this.activeAssistant = this.builder.appendAssistantPart(
      { type, text, time_created: envelope.timestampMs },
      this.assistantInput(envelope),
      { grouping: "current" },
    );
  }

  private appendToolCall(envelope: GrokUpdate): void {
    const callId = asString(envelope.update.toolCallId)?.trim();
    const updateMeta = asRecord(envelope.update._meta);
    const nativeTool = asRecord(updateMeta?.["x.ai/tool"]);
    const name =
      asString(nativeTool?.name)?.trim() || asString(envelope.update.title)?.trim() || "tool";
    if (!this.prepareAssistant(envelope, Boolean(callId))) return;
    const metadata = {
      kind: asString(nativeTool?.kind) ?? asString(envelope.update.kind),
      locations: envelope.update.locations,
    };
    const part: ToolPart = {
      type: "tool",
      tool: name,
      title: toolTitle(name),
      callID: callId,
      state: {
        status: toolStatus(envelope.update.status) ?? "running",
        input: envelope.update.rawInput,
        output: null,
        metadata,
      },
      time_created: envelope.timestampMs,
    };

    this.activeAssistant = this.builder.appendToolCall(part, this.assistantInput(envelope), {
      markModeAsTool: true,
      target: "current",
    });
  }

  private updateToolCall(envelope: GrokUpdate): void {
    const callId = asString(envelope.update.toolCallId)?.trim();
    if (!callId) return;
    this.builder.updateToolCall(callId, (part) => {
      const status = toolStatus(envelope.update.status);
      if (status) part.state.status = status;
      if (envelope.update.rawInput !== undefined) part.state.input = envelope.update.rawInput;

      const output = toolOutput(envelope.update);
      if (output !== undefined) {
        if (status === "error") part.state.error = output;
        else part.state.output = output;
      }

      const metadata = asRecord(part.state.metadata) ?? {};
      if (envelope.update.kind !== undefined) metadata.kind = envelope.update.kind;
      if (envelope.update.locations !== undefined) metadata.locations = envelope.update.locations;
      part.state.metadata = metadata;
    });
  }

  private updatePlan(envelope: GrokUpdate): void {
    const part = planPart(envelope.update, envelope.timestampMs);
    if (!this.prepareAssistant(envelope, part !== null) || !part) return;

    if (this.latestPlan) {
      this.latestPlan.text = part.text;
      this.latestPlan.approval_status = part.approval_status;
      this.latestPlan.time_created = part.time_created;
      return;
    }

    this.latestPlan = part;
    this.activeAssistant = this.builder.appendAssistantPart(part, this.assistantInput(envelope), {
      grouping: "current",
    });
  }
}

class UserRunTracker {
  private hasSeenPromptIndex = false;
  private isInUserRun = false;
  private currentPromptIndex: number | null = null;

  onUser(promptIndex: number | null): boolean {
    if (promptIndex !== null) this.hasSeenPromptIndex = true;
    const isCounted = this.hasSeenPromptIndex ? promptIndex !== null : true;
    const isNewRun =
      !this.isInUserRun ||
      ((this.hasSeenPromptIndex || promptIndex !== null) &&
        promptIndex !== this.currentPromptIndex);

    this.isInUserRun = true;
    if (!isNewRun) return false;
    this.currentPromptIndex = promptIndex;
    return isCounted;
  }

  onNonUser(): void {
    this.isInUserRun = false;
    this.currentPromptIndex = null;
  }
}

class RewindIndex {
  readonly survivingRecordIndexes: number[] = [];
  hasRewinds = false;
  private readonly promptStarts: number[] = [];
  private readonly userRuns = new UserRunTracker();

  process(record: Record<string, unknown>, recordIndex: number, fallbackTimestampMs: number): void {
    const envelope = unpackUpdate(record, fallbackTimestampMs);
    if (!envelope) {
      this.userRuns.onNonUser();
      this.survivingRecordIndexes.push(recordIndex);
      return;
    }

    const type = updateType(envelope);
    if (envelope.method === XAI_UPDATE_METHOD && type === "rewind_marker") {
      const target = asNumber(envelope.update.target_prompt_index);
      if (target === undefined || !Number.isSafeInteger(target) || target < 0) {
        this.userRuns.onNonUser();
        this.survivingRecordIndexes.push(recordIndex);
        return;
      }
      const truncateAt = this.promptStarts[target] ?? this.survivingRecordIndexes.length;
      this.survivingRecordIndexes.length = truncateAt;
      this.promptStarts.length = Math.min(this.promptStarts.length, target);
      this.userRuns.onNonUser();
      this.hasRewinds = true;
      return;
    }

    if (
      envelope.method !== XAI_UPDATE_METHOD &&
      type === "user_message_chunk" &&
      !isHostTurn(envelope.update)
    ) {
      const rawPromptIndex = asNumber(asRecord(envelope.update._meta)?.promptIndex);
      const promptIndex =
        rawPromptIndex !== undefined && Number.isSafeInteger(rawPromptIndex) && rawPromptIndex >= 0
          ? rawPromptIndex
          : null;
      if (this.userRuns.onUser(promptIndex)) {
        this.promptStarts.push(this.survivingRecordIndexes.length);
      }
    } else {
      this.userRuns.onNonUser();
    }

    this.survivingRecordIndexes.push(recordIndex);
  }
}

function parseTranscript(meta: GrokSessionMeta): TranscriptResult {
  const reducer = new GrokTranscriptReducer(meta.id, meta.currentModel, meta.createdAt);
  if (!meta.updatesPath || !existsSync(meta.updatesPath)) return reducer.finish(meta.stats);

  const rewindIndex = new RewindIndex();
  let recordIndex = 0;
  for (const record of readJsonlFile(meta.updatesPath)) {
    rewindIndex.process(record, recordIndex, meta.createdAt);
    reducer.process(record);
    recordIndex += 1;
  }
  if (!rewindIndex.hasRewinds) return reducer.finish(meta.stats);

  const survivingIndexes = new Set(rewindIndex.survivingRecordIndexes);
  const replay = new GrokTranscriptReducer(meta.id, meta.currentModel, meta.createdAt);
  recordIndex = 0;
  for (const record of readJsonlFile(meta.updatesPath)) {
    if (survivingIndexes.has(recordIndex)) replay.process(record);
    recordIndex += 1;
  }
  return replay.finish(meta.stats);
}

const AGENT_METADATA = getAgentCatalogEntry("grok");

export class GrokAgent extends FileSystemSessionSource<GrokSessionMeta> {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  private basePath: string | null = this.configuredSourceRoot;

  private findBasePath(): string | null {
    return (
      this.configuredSourceRoot ??
      firstExisting(join(resolveGrokDataRoot(), "sessions"), "data/grok")
    );
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    return this.basePath !== null && this.listSessionSources().length > 0;
  }

  getSessionWatchPlan() {
    if (this.configuredSourceRoot) {
      return {
        status: "supported" as const,
        targets: [{ root: dirname(this.configuredSourceRoot), path: this.configuredSourceRoot }],
      };
    }
    const dataRoot = resolveGrokDataRoot();
    return {
      status: "supported" as const,
      targets: [{ root: dataRoot, path: join(dataRoot, "sessions") }, { path: "data/grok" }],
    };
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    this.basePath ??= this.findBasePath();
    if (!this.basePath) return [];

    const sources = this.walkFiles(this.basePath, (entry) => entry.name === SUMMARY_FILE);
    return sources.flatMap((source) => {
      const summary = parseSummary(source);
      if (!summary || !matchesScanWindow(summary.updatedAt, options)) return [];
      return [
        {
          sessionId: summary.id,
          sourcePath: source.file,
          fingerprint: this.sourceFingerprint(source),
        },
      ];
    });
  }

  scanSessionSource(sourcePath: string): SessionHead | null {
    return getParsedSession(this.parseSessionHeadResult(sourcePath));
  }

  protected override scanSessionSourceResult(
    source: SessionSourceRef,
  ): ParseSessionResult<SessionHead> {
    return this.parseSessionHeadResult(source.sourcePath);
  }

  private parseSessionHeadResult(sourcePath: string): ParseSessionResult<SessionHead> {
    const source = this.sessionSourceFile(sourcePath);
    const summary = parseSummary(source);
    if (!summary) return skippedSession("malformed summary");

    const sessionDir = dirname(source.file);
    const updatesPath = join(sessionDir, UPDATES_FILE);
    const existingUpdatesPath = existsSync(updatesPath) ? updatesPath : null;
    const headData = scanHeadData(existingUpdatesPath, summary.createdAt);
    const messageCount = headData.visibleMessageCount;
    if (messageCount === 0) return filteredSession("no visible messages");

    const title = resolveSessionTitle(
      summary.title,
      headData.firstUserText,
      basenameTitle(summary.cwd),
    );
    const stats: SessionStats = { message_count: messageCount, ...headData.stats };
    const fingerprint = this.sourceFingerprint(source);
    const head: SessionHead = {
      ...this.sessionIdentity(summary.id),
      title,
      directory: summary.cwd,
      parent_reference: summary.parentSessionId
        ? { agentName: this.name, sessionId: summary.parentSessionId }
        : undefined,
      time_created: summary.createdAt,
      time_updated: summary.updatedAt,
      stats,
      model_usage: Object.keys(headData.modelUsage).length > 0 ? headData.modelUsage : undefined,
    };

    this.sessionMetaMap.set(summary.id, {
      id: summary.id,
      title,
      sourcePath: source.file,
      sourceFingerprint: fingerprint,
      sourceMtimeMs: summary.updatedAt,
      directory: summary.cwd,
      messageCount,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      currentModel: summary.currentModel,
      parentSessionId: summary.parentSessionId,
      updatesPath: existingUpdatesPath,
      stats,
    });
    return parsedSession(head);
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    const transcript = parseTranscript(meta);
    return {
      ...this.sessionIdentity(meta.id),
      title: meta.title,
      directory: meta.directory,
      parent_reference: meta.parentSessionId
        ? { agentName: this.name, sessionId: meta.parentSessionId }
        : undefined,
      version: undefined,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }

  private sourceFingerprint(source: SessionSourceFile): string {
    const sessionDir = dirname(source.file);
    return JSON.stringify([
      HEAD_INDEX_VERSION,
      PARSER_VERSION,
      source.stat.mtimeMs,
      source.stat.size,
      optionalFileFingerprint(join(sessionDir, UPDATES_FILE)),
    ]);
  }
}
