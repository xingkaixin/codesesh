import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SingleFileSessionSource,
  filteredSession,
  getParsedSession,
  parsedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  FileSessionMeta,
  ParseSessionResult,
  SessionSourceFile,
  SessionSourceRef,
} from "./base.js";
import type { Message, MessagePart, SessionDetail, SessionHead } from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { readJsonlFile } from "../utils/jsonl.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asNumber, asRecord, asString, narrowField } from "../utils/narrow.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

const HEAD_INDEX_VERSION = "pi-head-v1";
const PARSER_VERSION = "pi-parser-v3";

export function resolvePiDataRoot(): string {
  return resolveHomePath("PI_HOME", ".pi");
}

interface SessionMeta extends FileSessionMeta {
  headIndexVersion: string;
  parserVersion: string;
}

interface ParsedPiFile {
  sessionId: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  pathEntries: Record<string, unknown>[];
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const ts = Date.parse(text);
  return Number.isNaN(ts) ? 0 : ts;
}

function narrowPiField<T>(
  field: string,
  value: unknown,
  narrow: (v: unknown) => T | undefined,
): T | undefined {
  return narrowField("pi", field, value, narrow);
}

/**
 * Reports drift only when the timestamp is present but neither a number nor
 * a string (e.g. an object) — actual date parsing (and its silent-0
 * fallback for unparseable text) is unchanged, via `parseTimestampMs`.
 */
function narrowTimestampMs(field: string, value: unknown): number {
  const shaped = narrowPiField(field, value, (v) =>
    typeof v === "number" || typeof v === "string" ? v : undefined,
  );
  return shaped === undefined ? 0 : parseTimestampMs(shaped);
}

function extractSessionIdFromFilename(filePath: string): string {
  const stem = basename(filePath, ".jsonl");
  const underscore = stem.indexOf("_");
  return underscore >= 0 ? stem.slice(underscore + 1) || stem : stem;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isObject(item)) return "";
      if (item["type"] === "text") return String(item["text"] ?? "");
      if (item["type"] === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeTextParts(content: unknown, timestampMs: number): MessagePart[] {
  const text = cleanInternalText(contentToText(content));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

function getEntryTimestamp(entry: Record<string, unknown>): number {
  return narrowTimestampMs("entry.timestamp", entry["timestamp"]);
}

function chooseLeafEntry(entries: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (typeof entries[index]?.["id"] === "string") return entries[index]!;
  }
  return null;
}

function buildCurrentPathEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry["id"];
    if (typeof id === "string" && id) byId.set(id, entry);
  }

  const leaf = chooseLeafEntry(entries);
  if (!leaf) return [];

  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let current: Record<string, unknown> | undefined = leaf;
  while (current) {
    const id = String(current["id"] ?? "");
    if (!id || seen.has(id)) break;
    seen.add(id);
    path.push(current);
    const parentId: unknown = current["parentId"];
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }

  return path.reverse();
}

export class PiAgent extends SingleFileSessionSource<SessionMeta> {
  readonly name = "pi";
  readonly displayName = "Pi";

  private basePath: string | null = null;

  private findBasePath(): string | null {
    return firstExisting(join(resolvePiDataRoot(), "agent", "sessions"), "data/pi");
  }

  getSessionWatchPlan() {
    const dataRoot = resolvePiDataRoot();
    return {
      status: "supported" as const,
      targets: [
        { root: dataRoot, path: join(dataRoot, "agent", "sessions") },
        { root: "data/pi", path: "data/pi" },
      ],
    };
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    return this.listSessionFiles().length > 0;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    return this.listSessionFiles(options).map(({ file, stat }) => ({
      sessionId: extractSessionIdFromFilename(file),
      sourcePath: file,
      fingerprint: this.sourceFingerprint(stat),
    }));
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);

    const parsed = this.parsePiFile(meta.sourcePath);
    const state = this.convertEntries(parsed.pathEntries);

    return {
      reference: { agentName: this.name, sessionId: meta.id },
      id: meta.id,
      title: meta.title,
      slug: `pi/${meta.id}`,
      directory: meta.directory,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: {
        message_count: state.messages.length,
        total_input_tokens: state.totalInputTokens,
        total_output_tokens: state.totalOutputTokens,
        total_cache_read_tokens: state.totalCacheReadTokens || undefined,
        total_cache_create_tokens: state.totalCacheCreateTokens || undefined,
        total_cost: state.totalCost,
        cost_source: state.costSource,
      },
      messages: state.messages,
    };
  }

  private listSessionFiles(options?: AgentScanOptions): SessionSourceFile[] {
    if (!this.basePath) return [];
    return this.walkFiles(
      this.basePath,
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
      { scanWindow: options },
    );
  }

  protected createFileSessionMeta(head: SessionHead, source: SessionSourceFile): SessionMeta {
    return this.buildFileSessionMeta({
      head,
      source,
      fingerprint: this.sourceFingerprint(source.stat),
      extras: {
        headIndexVersion: HEAD_INDEX_VERSION,
        parserVersion: PARSER_VERSION,
      },
    });
  }

  /** Fingerprint depends on an already-fetched stat to avoid re-statting the same file. */
  private sourceFingerprint(stat: { mtimeMs: number; size: number }): string {
    return JSON.stringify([HEAD_INDEX_VERSION, PARSER_VERSION, stat.mtimeMs, stat.size]);
  }

  protected parseFileSessionHead(filePath: string): SessionHead | null {
    return getParsedSession(this.parseFileSessionHeadResult(filePath));
  }

  protected override parseFileSessionHeadResult(filePath: string): ParseSessionResult<SessionHead> {
    const parsed = this.parsePiFile(filePath);
    const state = this.convertEntries(parsed.pathEntries);
    const messageCount = state.messages.length;
    if (messageCount === 0) return filteredSession("no visible messages");

    const modelUsage = Object.keys(state.modelUsage).length > 0 ? state.modelUsage : undefined;
    return parsedSession({
      id: parsed.sessionId,
      slug: `pi/${parsed.sessionId}`,
      title: parsed.title,
      directory: parsed.directory,
      time_created: parsed.createdAt,
      time_updated: parsed.updatedAt,
      stats: {
        message_count: messageCount,
        total_input_tokens: state.totalInputTokens,
        total_output_tokens: state.totalOutputTokens,
        total_cache_read_tokens: state.totalCacheReadTokens || undefined,
        total_cache_create_tokens: state.totalCacheCreateTokens || undefined,
        total_cost: state.totalCost,
        cost_source: state.costSource,
      },
      model_usage: modelUsage,
    });
  }

  private parsePiFile(filePath: string): ParsedPiFile {
    // Single streaming pass: the file is never held as a string, and header
    // selection happens inline instead of scanning a materialized record array.
    let header: Record<string, unknown> | null = null;
    let recordCount = 0;
    const entries: Record<string, unknown>[] = [];

    for (const record of readJsonlFile(filePath)) {
      recordCount += 1;
      if (record["type"] === "session") {
        header ??= record;
        continue;
      }
      entries.push(record);
    }

    if (recordCount === 0) throw new Error("empty file");
    if (!header) throw new Error("missing session header");

    const pathEntries = buildCurrentPathEntries(entries);
    if (pathEntries.length === 0) throw new Error("empty session tree");

    const sessionId = extractSessionIdFromFilename(filePath);
    if (!sessionId) throw new Error("missing session id");

    const stat = this.sessionSourceFile(filePath).stat;
    const directory = String(header["cwd"] ?? "").trim() || basename(filePath, ".jsonl");
    const createdAt = narrowTimestampMs("session.timestamp", header["timestamp"]) || stat.mtimeMs;
    const updatedAt = pathEntries.reduce(
      (max, entry) => Math.max(max, getEntryTimestamp(entry)),
      createdAt,
    );
    const explicitTitle = this.extractSessionName(pathEntries);
    const messageTitle = this.extractTitle(pathEntries);
    const directoryTitle = basenameTitle(directory);

    return {
      sessionId,
      directory,
      createdAt,
      updatedAt,
      title: resolveSessionTitle(explicitTitle, messageTitle, directoryTitle),
      pathEntries,
    };
  }

  private extractSessionName(entries: Record<string, unknown>[]): string | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry["type"] !== "session_info") continue;
      const name = normalizeTitleText(String(entry["name"] ?? ""));
      if (name) return name;
    }
    return null;
  }

  private extractTitle(entries: Record<string, unknown>[]): string | null {
    for (const entry of entries) {
      if (entry["type"] !== "message") continue;
      const message = entry["message"];
      if (!isObject(message) || message["role"] !== "user") continue;
      const title = normalizeTitleText(contentToText(message["content"]));
      if (title) return title;
    }
    return null;
  }

  private convertEntries(entries: Record<string, unknown>[]): {
    messages: Message[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreateTokens: number;
    totalCost: number;
    costSource: Message["cost_source"];
    modelUsage: Record<string, number>;
  } {
    const builder = new TranscriptBuilder({ messageDefaults: "sparse" });
    const modelUsage: Record<string, number> = {};

    for (const entry of entries) {
      const timestampMs = getEntryTimestamp(entry);
      const type = String(entry["type"] ?? "");

      if (type === "message") {
        const message = narrowPiField("entry.message", entry["message"], asRecord);
        if (!message) continue;
        const result = this.convertAgentMessage(entry, message, timestampMs, builder);
        if (!result) continue;
        if (result.message) builder.appendMessage(result.message);
        if (result.model && result.totalTokens > 0) {
          modelUsage[result.model] = (modelUsage[result.model] ?? 0) + result.totalTokens;
        }
        continue;
      }

      const summary = this.convertSummaryEntry(entry, timestampMs);
      if (summary) builder.appendMessage(summary);
    }

    const result = builder.finish();

    return {
      messages: result.messages,
      totalInputTokens: result.stats.total_input_tokens,
      totalOutputTokens: result.stats.total_output_tokens,
      totalCacheReadTokens: result.stats.total_cache_read_tokens ?? 0,
      totalCacheCreateTokens: result.stats.total_cache_create_tokens ?? 0,
      totalCost: result.stats.total_cost,
      costSource: result.stats.cost_source,
      modelUsage,
    };
  }

  private convertAgentMessage(
    entry: Record<string, unknown>,
    message: Record<string, unknown>,
    timestampMs: number,
    builder: TranscriptBuilder,
  ): {
    message?: TranscriptMessageInput;
    totalTokens: number;
    model: string | null;
  } | null {
    const id = narrowPiField("message.id", entry["id"], asString) ?? "";
    const role = narrowPiField("message.role", message["role"], asString) ?? "";

    if (role === "user") {
      const parts = normalizeTextParts(message["content"], timestampMs);
      if (parts.length === 0) return null;
      return this.emptyUsageResult({ id, role: "user", timestampMs, parts });
    }

    if (role === "assistant") {
      const parts = this.normalizeAssistantParts(message["content"], timestampMs);
      if (parts.length === 0) return null;
      const usage = this.normalizeUsage(message["usage"]);
      const model = typeof message["model"] === "string" ? message["model"].trim() : null;
      const estimatedCost = usage.cost === null ? estimateTokenCost(model, usage.tokens) : null;
      const cost = usage.cost ?? estimatedCost ?? 0;
      const costSource = cost > 0 ? (usage.cost === null ? "estimated" : "recorded") : undefined;
      return {
        message: {
          id,
          role: "assistant",
          agent: "pi",
          timestampMs,
          parts,
          provider: typeof message["provider"] === "string" ? message["provider"] : null,
          model,
          tokens: usage.tokens,
          cost: cost || undefined,
          costSource,
        },
        totalTokens: usage.totalTokens,
        model,
      };
    }

    if (role === "toolResult") {
      this.attachToolResult(message, timestampMs, builder);
      return this.emptyUsageResult();
    }

    if (role === "bashExecution") {
      return this.emptyUsageResult(this.convertBashExecution(id, message, timestampMs));
    }

    if (role === "custom" && message["display"] === true) {
      const parts = normalizeTextParts(message["content"], timestampMs);
      if (parts.length === 0) return null;
      return this.emptyUsageResult({ id, role: "user", timestampMs, parts });
    }

    if (role === "branchSummary" || role === "compactionSummary") {
      const summary = String(message["summary"] ?? "").trim();
      if (!summary) return null;
      return this.emptyUsageResult({
        id,
        role: "assistant",
        agent: "pi",
        timestampMs,
        parts: [{ type: "text", text: summary, time_created: timestampMs }],
      });
    }

    return null;
  }

  private normalizeAssistantParts(content: unknown, timestampMs: number): MessagePart[] {
    if (!Array.isArray(content)) return [];

    const parts: MessagePart[] = [];
    for (const item of content) {
      if (!isObject(item)) continue;
      const type = item["type"];

      if (type === "text") {
        const text = cleanInternalText(String(item["text"] ?? ""));
        if (text) parts.push({ type: "text", text, time_created: timestampMs });
        continue;
      }

      if (type === "thinking") {
        const text = cleanInternalText(String(item["thinking"] ?? ""));
        if (text) parts.push({ type: "reasoning", text, time_created: timestampMs });
        continue;
      }

      if (type === "toolCall") {
        const callId = String(item["id"] ?? "").trim();
        const toolName = String(item["name"] ?? "").trim() || "tool";
        const toolPart: MessagePart = {
          type: "tool",
          tool: toolName,
          title: `Tool: ${toolName}`,
          callID: callId || undefined,
          time_created: timestampMs,
          state: {
            status: "running",
            input: item["arguments"] ?? {},
          },
        };
        parts.push(toolPart);
      }
    }

    return parts;
  }

  private attachToolResult(
    message: Record<string, unknown>,
    timestampMs: number,
    builder: TranscriptBuilder,
  ): void {
    const callId = String(message["toolCallId"] ?? "").trim();
    const output = normalizeTextParts(message["content"], timestampMs);
    if (!callId) return;
    builder.resolveToolCall(callId, {
      output,
      status: message["isError"] === true ? "error" : "completed",
      metadata: message["details"],
      consume: true,
    });
  }

  private convertBashExecution(
    id: string,
    message: Record<string, unknown>,
    timestampMs: number,
  ): TranscriptMessageInput {
    const command = String(message["command"] ?? "");
    const output = String(message["output"] ?? "");
    const isError = Number(message["exitCode"] ?? 0) !== 0 || message["cancelled"] === true;
    return {
      id,
      role: "tool",
      timestampMs,
      parts: [
        {
          type: "tool",
          tool: "bash",
          title: "Tool: bash",
          time_created: timestampMs,
          state: {
            status: isError ? "error" : "completed",
            input: { command },
            output: output ? [{ type: "text", text: output, time_created: timestampMs }] : [],
            metadata: {
              exitCode: message["exitCode"],
              cancelled: message["cancelled"],
              truncated: message["truncated"],
              fullOutputPath: message["fullOutputPath"],
            },
          },
        },
      ],
    };
  }

  private convertSummaryEntry(
    entry: Record<string, unknown>,
    timestampMs: number,
  ): TranscriptMessageInput | null {
    const type = entry["type"];
    if (type !== "compaction" && type !== "branch_summary" && type !== "custom_message") {
      return null;
    }

    if (type === "custom_message" && entry["display"] !== true) return null;

    const rawText =
      type === "custom_message" ? contentToText(entry["content"]) : String(entry["summary"] ?? "");
    const text = cleanInternalText(rawText);
    if (!text) return null;

    return {
      id: narrowPiField("summary.id", entry["id"], asString) ?? "",
      role: type === "custom_message" ? "user" : "assistant",
      agent: type === "custom_message" ? undefined : "pi",
      timestampMs,
      parts: [{ type: "text", text, time_created: timestampMs }],
    };
  }

  private normalizeUsage(raw: unknown): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    totalTokens: number;
    cost: number | null;
    tokens: Message["tokens"];
  } {
    const usage = narrowPiField("message.usage", raw, asRecord) ?? {};
    const inputTokens = narrowPiField("message.usage.input", usage["input"], asNumber) ?? 0;
    const outputTokens = narrowPiField("message.usage.output", usage["output"], asNumber) ?? 0;
    const cacheReadTokens =
      narrowPiField("message.usage.cacheRead", usage["cacheRead"], asNumber) ?? 0;
    const cacheCreateTokens =
      narrowPiField("message.usage.cacheWrite", usage["cacheWrite"], asNumber) ?? 0;
    const totalTokens =
      narrowPiField("message.usage.totalTokens", usage["totalTokens"], asNumber) ??
      inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
    const cost = isObject(usage["cost"]) ? Number(usage["cost"]["total"] ?? 0) : null;

    return {
      inputTokens: inputTokens + cacheReadTokens + cacheCreateTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      totalTokens,
      cost: cost && Number.isFinite(cost) ? cost : null,
      tokens: {
        input: inputTokens + cacheReadTokens + cacheCreateTokens,
        output: outputTokens,
        cache_read: cacheReadTokens || undefined,
        cache_create: cacheCreateTokens || undefined,
      },
    };
  }

  private emptyUsageResult(message?: TranscriptMessageInput): {
    message?: TranscriptMessageInput;
    totalTokens: number;
    model: string | null;
  } {
    return {
      message,
      totalTokens: 0,
      model: null,
    };
  }
}
