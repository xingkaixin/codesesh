import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  FileSystemSessionSource,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  skippedSession,
} from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { parseJsonlLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { estimateTokenCost } from "../utils/cost.js";
import type { AgentScanOptions, SessionCacheMeta, SessionSourceRef } from "./base.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

const HEAD_INDEX_VERSION = "claudecode-head-v2";

interface ClaudeUsage {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  sourceMtimeMs: number;
  indexPath: string | null;
  indexMtimeMs: number | null;
  headIndexVersion: string;
  directory: string;
  model: string | null | undefined;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

function parseTimestampMs(data: Record<string, unknown>): number {
  const raw = String(data["timestamp"] ?? "").trim();
  if (!raw) return 0;
  try {
    return new Date(raw.includes("Z") ? raw : raw + "Z").getTime();
  } catch {
    return 0;
  }
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractClaudeUsage(
  data: Record<string, unknown>,
  msg: Record<string, unknown>,
): ClaudeUsage | null {
  const usage = msg["usage"];
  if (!usage || typeof usage !== "object") return null;

  const u = usage as Record<string, unknown>;
  const requestId = typeof data["requestId"] === "string" ? data["requestId"].trim() : "";
  const uuid = typeof data["uuid"] === "string" ? data["uuid"].trim() : "";
  const key = requestId || uuid;
  if (!key) return null;

  return {
    key,
    input: numericUsage(u["input_tokens"]),
    output: numericUsage(u["output_tokens"]),
    cacheRead: numericUsage(u["cache_read_input_tokens"]),
    cacheCreate: numericUsage(u["cache_creation_input_tokens"]),
  };
}

export class ClaudeCodeAgent extends FileSystemSessionSource<SessionMeta> {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";

  private basePath: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionsIndexCache: Record<string, any> = {};
  private sessionsIndexMtime: Record<string, number | null> = {};

  private findBasePath(): string | null {
    const roots = resolveProviderRoots();
    return firstExisting(join(roots.claudeRoot, "projects"), "data/claudecode");
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    try {
      for (const entry of readdirSync(this.basePath)) {
        const dir = join(this.basePath, entry);
        if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"))) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    const refs: SessionSourceRef[] = [];
    for (const projectDir of this.listProjectDirs()) {
      for (const file of this.listJsonlFiles(projectDir)) {
        try {
          if (!matchesScanWindow(statSync(file).mtimeMs, options)) continue;
        } catch {
          continue;
        }
        const sessionId = basename(file, ".jsonl");
        refs.push({
          sessionId,
          sourcePath: file,
          fingerprint: this.sourceFingerprint(file, projectDir),
        });
      }
    }
    return refs;
  }

  scanSessionSource(sourcePath: string): SessionHead | null {
    const projectDir = dirname(sourcePath);
    const head = getParsedSession(this.parseSessionHeadResult(sourcePath, projectDir));
    if (head) {
      this.sessionMetaMap.set(head.id, this.buildSessionMeta(head, sourcePath, projectDir));
    }
    return head;
  }

  getSessionData(sessionId: string): SessionData {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!existsSync(meta.sourcePath)) {
      throw new Error(`Session file missing: ${meta.sourcePath}`);
    }

    const content = readFileSync(meta.sourcePath, "utf-8");
    const builder = new TranscriptBuilder();
    const assistantUuidToToolCalls = new Map<string, string[]>();
    const countedUsageKeys = new Set<string>();
    for (const record of parseJsonlLines(content)) {
      try {
        this.convertRecord(record, builder, assistantUuidToToolCalls, countedUsageKeys);
      } catch {
        // skip malformed records
      }
    }

    const transcript = builder.finish();

    return {
      id: meta.id,
      title: meta.title,
      slug: `claudecode/${meta.id}`,
      directory: meta.directory,
      version: undefined,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }

  // --- Private helpers ---

  private listProjectDirs(): string[] {
    if (!this.basePath) return [];
    try {
      return readdirSync(this.basePath)
        .map((e) => join(this.basePath!, e))
        .filter((p) => existsSync(p));
    } catch {
      return [];
    }
  }

  private listJsonlFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && f !== "sessions-index.json")
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  }

  private buildSessionMeta(head: SessionHead, file: string, projectDir: string): SessionMeta {
    const indexPath = this.getSessionsIndexPath(projectDir);
    return {
      id: head.id,
      title: head.title,
      sourcePath: file,
      sourceFingerprint: this.sourceFingerprint(file, projectDir),
      sourceMtimeMs: statSync(file).mtimeMs,
      indexPath: existsSync(indexPath) ? indexPath : null,
      indexMtimeMs: this.getFileMtimeMs(indexPath),
      headIndexVersion: HEAD_INDEX_VERSION,
      directory: head.directory,
      model: head.stats.total_tokens ? "unknown" : undefined,
      messageCount: head.stats.message_count,
      createdAt: head.time_created,
      updatedAt: head.time_updated ?? head.time_created,
    };
  }

  private sourceFingerprint(file: string, projectDir: string): string {
    const stat = statSync(file);
    const indexPath = this.getSessionsIndexPath(projectDir);
    return JSON.stringify([
      HEAD_INDEX_VERSION,
      stat.mtimeMs,
      stat.size,
      this.getFileMtimeMs(indexPath),
    ]);
  }

  private getSessionsIndexPath(projectDir: string): string {
    return join(projectDir, "sessions-index.json");
  }

  private getFileMtimeMs(filePath: string): number | null {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  private loadSessionsIndex(projectDir: string): Map<string, Record<string, unknown>> {
    const cacheKey = basename(projectDir);
    const indexPath = this.getSessionsIndexPath(projectDir);
    const mtime = this.getFileMtimeMs(indexPath);

    // Invalidate when the index file mtime advances so long-running processes
    // pick up title changes without relying on callers to evict manually.
    if (cacheKey in this.sessionsIndexCache && this.sessionsIndexMtime[cacheKey] === mtime) {
      return this.sessionsIndexCache[cacheKey];
    }

    const map = new Map<string, Record<string, unknown>>();

    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, "utf-8"));
        const entries: Record<string, unknown>[] = data?.entries ?? [];
        for (const entry of entries) {
          const sid = entry?.sessionId;
          if (typeof sid === "string") {
            map.set(sid, entry);
          }
        }
      } catch {
        // ignore
      }
    }

    this.sessionsIndexCache[cacheKey] = map;
    this.sessionsIndexMtime[cacheKey] = mtime;
    return map;
  }

  private parseSessionHead(filePath: string, projectDir: string): SessionHead | null {
    return getParsedSession(this.parseSessionHeadResult(filePath, projectDir));
  }

  private parseSessionHeadResult(
    filePath: string,
    projectDir: string,
  ): ParseSessionResult<SessionHead> {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    if (lines.length === 0) return skippedSession("empty file");

    const sessionId = basename(filePath, ".jsonl");

    let firstRecord: Record<string, unknown>;
    try {
      firstRecord = JSON.parse(lines[0]!);
    } catch {
      return skippedSession("malformed first record");
    }

    const createdAt = parseTimestampMs(firstRecord) || statSync(filePath).mtimeMs;

    // Try to get title from sessions-index.json
    const index = this.loadSessionsIndex(projectDir);
    const indexEntry = index.get(sessionId);
    const explicitTitle = indexEntry?.summary ? String(indexEntry.summary) : null;

    // Extract lightweight metadata; cwd lives in user-type records, not the first line
    let updatedAt = createdAt;
    let messageCount = 0;
    let model: string | null = null;
    let cwd: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreateTokens = 0;
    let totalCost = 0;
    const modelUsageMap: Record<string, number> = {};
    const countedUsageKeys = new Set<string>();

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (isInternalEventType(data["type"])) continue;
        const ts = parseTimestampMs(data);
        if (ts > updatedAt) updatedAt = ts;

        if (!cwd && data["cwd"] && typeof data["cwd"] === "string") {
          cwd = data["cwd"];
        }

        const msg = data["message"];
        if (msg && typeof msg === "object") {
          const role = (msg as Record<string, unknown>)["role"];
          if (typeof role === "string" && role.trim()) {
            messageCount++;
          }
          if (!model) {
            const m = (msg as Record<string, unknown>)["model"];
            if (typeof m === "string" && m.trim()) model = m.trim();
          }
          if (role === "assistant") {
            const usage = extractClaudeUsage(data, msg as Record<string, unknown>);
            if (usage && !countedUsageKeys.has(usage.key)) {
              countedUsageKeys.add(usage.key);
              const inputTokens = usage.input;
              const cacheRead = usage.cacheRead;
              const cacheCreate = usage.cacheCreate;
              const outputTokens = usage.output;

              totalInputTokens += inputTokens + cacheRead + cacheCreate;
              totalOutputTokens += outputTokens;
              totalCacheReadTokens += cacheRead;
              totalCacheCreateTokens += cacheCreate;

              const m = (msg as Record<string, unknown>)["model"];
              if (typeof m === "string" && m.trim()) {
                const name = m.trim();
                const msgTotal = inputTokens + cacheRead + cacheCreate + outputTokens;
                modelUsageMap[name] = (modelUsageMap[name] ?? 0) + msgTotal;
                const cost = estimateTokenCost(name, {
                  input: inputTokens + cacheRead + cacheCreate,
                  output: outputTokens,
                  cache_read: cacheRead,
                  cache_create: cacheCreate,
                });
                if (cost !== null) totalCost += cost;
              }
            }
          }
        }
      } catch {
        // skip
      }
    }

    const directory = cwd ?? projectDir;

    // Extract first user message as fallback title
    const messageTitle = this.extractTitle(lines);
    const directoryTitle = basenameTitle(directory) || basenameTitle(projectDir);

    const title = resolveSessionTitle(explicitTitle, messageTitle, directoryTitle);

    const hasModelUsage = Object.keys(modelUsageMap).length > 0;
    if (messageCount === 0) return filteredSession("no visible messages");

    return parsedSession({
      id: sessionId,
      slug: `claudecode/${sessionId}`,
      title,
      directory,
      time_created: createdAt,
      time_updated: updatedAt,
      stats: {
        message_count: messageCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
        total_cache_read_tokens: totalCacheReadTokens,
        total_cache_create_tokens: totalCacheCreateTokens,
      },
      model_usage: hasModelUsage ? modelUsageMap : undefined,
    });
  }

  private extractTitle(lines: string[]): string | null {
    for (const line of lines.slice(0, 20)) {
      try {
        const data = JSON.parse(line);
        if (isInternalEventType(data["type"])) continue;
        const msg = data["message"];
        if (!msg || typeof msg !== "object") continue;
        if ((msg as Record<string, unknown>)["role"] !== "user") continue;

        const content = (msg as Record<string, unknown>)["content"];
        if (!content) continue;

        if (typeof content === "string") {
          const title = normalizeTitleText(content);
          if (title) return title;
        }
        if (Array.isArray(content)) {
          const texts = content
            .filter((item) => typeof item === "object" && item !== null && "text" in item)
            .map((item) => String((item as Record<string, unknown>)["text"] ?? ""))
            .join(" ");
          const title = normalizeTitleText(texts);
          if (title) return title;
        }
      } catch {
        // skip
      }
    }
    return null;
  }

  // --- Record conversion ---

  private convertRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
    countedUsageKeys: Set<string>,
  ): void {
    if (data["isMeta"] === true) return;

    const msgType = String(data["type"] ?? "");
    if (isInternalEventType(msgType)) return;

    if (msgType === "assistant") {
      this.convertAssistantRecord(data, builder, assistantUuidToToolCalls, countedUsageKeys);
    } else if (msgType === "user") {
      this.convertUserRecord(data, builder, assistantUuidToToolCalls);
    } else if (msgType === "tool_result") {
      this.convertToolResultRecord(data, builder);
    }
  }

  private convertAssistantRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
    countedUsageKeys: Set<string>,
  ): void {
    const msg = (data["message"] ?? {}) as Record<string, unknown>;
    const timestampMs = parseTimestampMs(data);
    const rawContent = (msg["content"] ?? []) as unknown[];
    const uuid = String(data["uuid"] ?? "");

    const toolCallIds: string[] = [];
    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (!item || typeof item !== "object") continue;
        const part = item as Record<string, unknown>;
        const partType = String(part["type"] ?? "");

        if (partType === "thinking") {
          const text = cleanInternalText(String(part["thinking"] ?? ""));
          if (text) {
            const message = builder.appendAssistantPart(
              this.buildReasoningPart(text, timestampMs),
              { id: uuid, timestampMs, agent: "claude" },
              { deduplicateTail: true },
            );
            this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
          }
          continue;
        }

        if (partType === "text") {
          const text = cleanInternalText(String(part["text"] ?? ""));
          if (text) {
            const message = builder.appendAssistantPart(
              this.buildTextPart(text, timestampMs),
              {
                id: uuid,
                timestampMs,
                agent: "claude",
              },
              { deduplicateTail: true },
            );
            this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
          }
          continue;
        }

        if (partType !== "tool_use") continue;

        const toolCallId = String(part["id"] ?? "").trim();

        const toolPart = this.buildToolPart(part, timestampMs);
        const message = builder.appendToolCall(
          toolPart,
          { id: uuid, timestampMs, agent: "claude" },
          { modeOnCreate: "tool" },
        );
        this.applyAssistantMetadata(message, data, msg, countedUsageKeys);
        if (toolCallId) {
          toolCallIds.push(toolCallId);
        }
      }
    }

    if (toolCallIds.length > 0) {
      assistantUuidToToolCalls.set(uuid, toolCallIds);
    }
  }

  private convertUserRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
  ): void {
    const msg = (data["message"] ?? {}) as Record<string, unknown>;
    const timestampMs = parseTimestampMs(data);
    const content = msg["content"] ?? "";
    const uuid = String(data["uuid"] ?? "");

    // String content — simple user message
    if (typeof content === "string") {
      const parts = this.normalizeUserTextParts(content, timestampMs);
      if (parts.length === 0) {
        builder.beginTurn();
        return;
      }
      builder.appendMessage({ id: uuid, role: "user", timestampMs, parts });
      return;
    }

    if (!Array.isArray(content)) {
      builder.beginTurn();
      return;
    }

    const visibleParts = this.normalizeUserTextParts(content, timestampMs);
    const toolStateUpdates = this.extractToolStateUpdates(data["toolUseResult"]);

    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const ci = item as Record<string, unknown>;
      if (ci["type"] !== "tool_result") continue;

      const toolCallId = this.resolveToolCallId(data, ci, assistantUuidToToolCalls);

      const outputParts = this.normalizeClaudeToolOutput(ci["content"], timestampMs);
      if (this.backfillToolOutput(builder, toolCallId, outputParts, toolStateUpdates)) {
        continue;
      }

      const fallback = this.buildFallbackToolMessage({
        messageId: uuid,
        timestampMs,
        toolCallId,
        outputParts,
      });
      if (fallback) builder.appendMessage(fallback);
    }

    if (visibleParts.length > 0) {
      builder.appendMessage({ id: uuid, role: "user", timestampMs, parts: visibleParts });
    }

    builder.beginTurn();
  }

  private convertToolResultRecord(data: Record<string, unknown>, builder: TranscriptBuilder): void {
    const timestampMs = parseTimestampMs(data);
    const msg = (data["message"] ?? {}) as Record<string, unknown>;
    const outputParts = this.normalizeClaudeToolOutput(msg["content"], timestampMs);
    const uuid = String(data["uuid"] ?? "");

    const fallback = this.buildFallbackToolMessage({
      messageId: uuid,
      timestampMs,
      toolCallId: null,
      outputParts,
    });
    if (fallback) builder.appendMessage(fallback);
    builder.beginTurn();
  }

  private buildTextPart(text: string, timestampMs: number): MessagePart {
    return { type: "text", text, time_created: timestampMs };
  }

  private buildReasoningPart(text: string, timestampMs: number): MessagePart {
    return { type: "reasoning", text, time_created: timestampMs };
  }

  private buildToolPart(part: Record<string, unknown>, timestampMs: number): MessagePart {
    const toolName = String(part["name"] ?? "");
    return {
      type: "tool",
      tool: toolName,
      callID: String(part["id"] ?? ""),
      title: `Tool: ${toolName}`,
      state: {
        input: part["input"] ?? {},
        output: null,
      },
      time_created: timestampMs,
    };
  }

  private applyAssistantMetadata(
    message: Message,
    data: Record<string, unknown>,
    msg: Record<string, unknown>,
    countedUsageKeys: Set<string>,
  ): void {
    const model = msg["model"];
    if (model && typeof model === "string" && !message.model) {
      message.model = model;
    }
    const usage = extractClaudeUsage(data, msg);
    if (usage && !message.tokens && !countedUsageKeys.has(usage.key)) {
      countedUsageKeys.add(usage.key);
      message.tokens = {
        input: usage.input + usage.cacheCreate + usage.cacheRead,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_create: usage.cacheCreate,
      };
      const cost = estimateTokenCost(message.model, message.tokens);
      if (cost !== null) {
        message.cost = cost;
        message.cost_source = "estimated";
      }
    }
  }

  // --- User content normalization ---

  private normalizeUserTextParts(content: unknown, timestampMs: number): MessagePart[] {
    if (typeof content === "string") {
      const text = cleanInternalText(content);
      return text ? [this.buildTextPart(text, timestampMs)] : [];
    }
    if (!Array.isArray(content)) return [];

    const parts: MessagePart[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        const ci = item as Record<string, unknown>;
        if (ci["type"] === "tool_result") continue;
        const text = cleanInternalText(String(ci["text"] ?? ""));
        if (text) parts.push(this.buildTextPart(text, timestampMs));
      } else if (typeof item === "string") {
        const text = cleanInternalText(item);
        if (text) parts.push(this.buildTextPart(text, timestampMs));
      }
    }
    return parts;
  }

  private normalizeClaudeToolOutput(content: unknown, timestampMs: number): MessagePart[] {
    if (typeof content === "string") {
      const text = cleanInternalText(content);
      return text ? [this.buildTextPart(text, timestampMs)] : [];
    }
    if (content === null || content === undefined) return [];

    if (Array.isArray(content)) {
      const parts: MessagePart[] = [];
      for (const item of content) {
        if (typeof item === "object" && item !== null) {
          const itemRecord = item as Record<string, unknown>;
          const source = itemRecord["source"] as Record<string, unknown> | undefined;
          if (itemRecord["type"] === "image" && source) {
            const data = typeof source["data"] === "string" ? source["data"] : "";
            const mimeType = typeof source["media_type"] === "string" ? source["media_type"] : "";
            if (data && mimeType.startsWith("image/")) {
              parts.push({ type: "image", data, mime_type: mimeType, time_created: timestampMs });
            }
            continue;
          }
          const text = String(itemRecord["text"] ?? itemRecord["content"] ?? "");
          const cleaned = cleanInternalText(text);
          if (cleaned) parts.push(this.buildTextPart(cleaned, timestampMs));
        } else if (typeof item === "string") {
          const text = cleanInternalText(item);
          if (text) parts.push(this.buildTextPart(text, timestampMs));
        }
      }
      return parts;
    }

    const text = cleanInternalText(String(content));
    return text ? [this.buildTextPart(text, timestampMs)] : [];
  }

  // --- Tool backfill ---

  private backfillToolOutput(
    builder: TranscriptBuilder,
    callId: string,
    outputParts: MessagePart[],
    stateUpdates?: Record<string, unknown>,
  ): boolean {
    if (!callId) return false;

    return builder.updateToolCall(callId, (part) => {
      const state = part.state ?? (part.state = {});
      if (outputParts.length > 0) {
        const existing = state.output;
        if (Array.isArray(existing)) existing.push(...outputParts);
        else if (existing == null) state.output = [...outputParts];
        else state.output = [existing, ...outputParts];
      }
      if (stateUpdates) Object.assign(state, stateUpdates);
      if (outputParts.length > 0 && !state.status) state.status = "completed";
    });
  }

  private resolveToolCallId(
    data: Record<string, unknown>,
    item: Record<string, unknown>,
    assistantUuidToToolCalls: Map<string, string[]>,
  ): string {
    const directId = String(item["tool_use_id"] ?? "").trim();
    if (directId) return directId;

    const sourceUuid = String(data["sourceToolAssistantUUID"] ?? "").trim();
    if (!sourceUuid) return "";

    const ids = assistantUuidToToolCalls.get(sourceUuid);
    if (ids && ids.length === 1) return ids[0]!;
    return "";
  }

  private extractToolStateUpdates(toolUseResult: unknown): Record<string, unknown> {
    if (!toolUseResult || typeof toolUseResult !== "object") return {};

    const result = toolUseResult as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    const success = result["success"];
    if (typeof success === "boolean") {
      updates["status"] = success ? "success" : "error";
    }

    const commandName = result["commandName"];
    if (commandName) {
      updates["meta"] = { commandName };
    }

    return updates;
  }

  // --- Fallback ---

  private buildFallbackToolMessage(opts: {
    messageId: string;
    timestampMs: number;
    toolCallId: string | null;
    outputParts: MessagePart[];
  }): TranscriptMessageInput | null {
    if (opts.outputParts.length === 0) return null;
    return {
      id: opts.messageId,
      role: "tool",
      timestampMs: opts.timestampMs,
      parts: opts.outputParts,
    };
  }
}
