import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  FileSystemSessionSource,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ParseSessionResult,
  SessionCacheMeta,
  SessionSourceRef,
} from "./base.js";
import type { Message, MessagePart, SessionData, SessionHead } from "../types/index.js";
import { firstExisting, resolveProviderRoots } from "../discovery/paths.js";
import { parseJsonlLines } from "../utils/jsonl.js";
import { estimateTokenCost } from "../utils/cost.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

const HEAD_INDEX_VERSION = "pi-head-v1";
const PARSER_VERSION = "pi-parser-v1";

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  sourceMtimeMs: number;
  headIndexVersion: string;
  parserVersion: string;
  directory: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
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
  return parseTimestampMs(entry["timestamp"]);
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

export class PiAgent extends FileSystemSessionSource<SessionMeta> {
  readonly name = "pi";
  readonly displayName = "Pi";

  private basePath: string | null = null;

  private findBasePath(): string | null {
    const roots = resolveProviderRoots();
    return firstExisting(join(roots.piRoot, "agent", "sessions"), "data/pi");
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    return this.listSessionFiles().length > 0;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    return this.listSessionFiles(options).map((file) => ({
      sessionId: extractSessionIdFromFilename(file),
      sourcePath: file,
      fingerprint: this.sourceFingerprint(file),
    }));
  }

  scanSessionSource(sourcePath: string): SessionHead | null {
    const head = getParsedSession(this.parseSessionHeadResult(sourcePath));
    if (head) {
      this.sessionMetaMap.set(head.id, this.buildSessionMeta(head, sourcePath));
    }
    return head;
  }

  getSessionData(sessionId: string): SessionData {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);

    const parsed = this.parsePiFile(meta.sourcePath);
    const state = this.convertEntries(parsed.pathEntries);

    return {
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
        cost_source: state.totalCost > 0 ? "recorded" : undefined,
      },
      messages: state.messages,
    };
  }

  private listSessionFiles(options?: AgentScanOptions): string[] {
    if (!this.basePath) return [];
    return this.walkJsonlFiles(this.basePath, options);
  }

  private walkJsonlFiles(dir: string, options?: AgentScanOptions): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.walkJsonlFiles(fullPath, options));
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (!matchesScanWindow(statSync(fullPath).mtimeMs, options)) continue;
        files.push(fullPath);
      }
    } catch {
      // skip inaccessible dirs
    }
    return files;
  }

  private buildSessionMeta(head: SessionHead, file: string): SessionMeta {
    return {
      id: head.id,
      title: head.title,
      sourcePath: file,
      sourceFingerprint: this.sourceFingerprint(file),
      sourceMtimeMs: statSync(file).mtimeMs,
      headIndexVersion: HEAD_INDEX_VERSION,
      parserVersion: PARSER_VERSION,
      directory: head.directory,
      messageCount: head.stats.message_count,
      createdAt: head.time_created,
      updatedAt: head.time_updated ?? head.time_created,
    };
  }

  private sourceFingerprint(file: string): string {
    const stat = statSync(file);
    return JSON.stringify([HEAD_INDEX_VERSION, PARSER_VERSION, stat.mtimeMs, stat.size]);
  }

  private parseSessionHeadResult(filePath: string): ParseSessionResult<SessionHead> {
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
        cost_source: state.totalCost > 0 ? "recorded" : undefined,
      },
      model_usage: modelUsage,
    });
  }

  private parsePiFile(filePath: string): ParsedPiFile {
    const records = Array.from(parseJsonlLines(readFileSync(filePath, "utf-8")));
    if (records.length === 0) throw new Error("empty file");

    const header = records.find((record) => record["type"] === "session");
    if (!header) throw new Error("missing session header");

    const entries = records.filter((record) => record["type"] !== "session");
    const pathEntries = buildCurrentPathEntries(entries);
    if (pathEntries.length === 0) throw new Error("empty session tree");

    const sessionId = String(header["id"] ?? extractSessionIdFromFilename(filePath)).trim();
    if (!sessionId) throw new Error("missing session id");

    const stat = statSync(filePath);
    const directory = String(header["cwd"] ?? "").trim() || basename(filePath, ".jsonl");
    const createdAt = parseTimestampMs(header["timestamp"]) || stat.mtimeMs;
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
    modelUsage: Record<string, number>;
  } {
    const builder = new TranscriptBuilder({ messageDefaults: "sparse" });
    const modelUsage: Record<string, number> = {};

    for (const entry of entries) {
      const timestampMs = getEntryTimestamp(entry);
      const type = String(entry["type"] ?? "");

      if (type === "message") {
        const message = entry["message"];
        if (!isObject(message)) continue;
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
    const id = String(entry["id"] ?? "");
    const role = String(message["role"] ?? "");

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
      const cost = usage.cost ?? estimateTokenCost(model, usage.tokens) ?? 0;
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
          costSource: cost > 0 ? "recorded" : undefined,
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
      id: String(entry["id"] ?? ""),
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
    const usage = isObject(raw) ? raw : {};
    const inputTokens = Number(usage["input"] ?? 0);
    const outputTokens = Number(usage["output"] ?? 0);
    const cacheReadTokens = Number(usage["cacheRead"] ?? 0);
    const cacheCreateTokens = Number(usage["cacheWrite"] ?? 0);
    const totalTokens = Number(
      usage["totalTokens"] ?? inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
    );
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
