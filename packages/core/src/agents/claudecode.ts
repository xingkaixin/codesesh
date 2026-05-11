import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  BaseAgent,
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
import { cleanInternalText, cleanParsedMessages } from "../utils/session-normalization.js";
import { perf } from "../utils/perf.js";
import { estimateTokenCost } from "../utils/cost.js";
import type { AgentScanOptions, SessionCacheMeta, ChangeCheckResult } from "./base.js";

const RECENT_SESSION_REVALIDATION_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
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

export class ClaudeCodeAgent extends BaseAgent {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";

  private basePath: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionsIndexCache: Record<string, any> = {};
  private sessionMetaMap = new Map<string, SessionMeta>();

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

  scan(options?: AgentScanOptions): SessionHead[] {
    if (!this.basePath) return [];

    const scanMarker = perf.start("claudecode:scan");
    const heads: SessionHead[] = [];

    const listMarker = perf.start("listProjectDirs");
    const projectDirs = this.listProjectDirs();
    perf.end(listMarker);

    for (const projectDir of projectDirs) {
      const fileMarker = perf.start(`listJsonlFiles:${basename(projectDir)}`);
      const files = this.listJsonlFiles(projectDir);
      perf.end(fileMarker);

      for (const file of files) {
        try {
          if (!matchesScanWindow(statSync(file).mtimeMs, options)) continue;

          const parseMarker = perf.start(`parseSessionHead:${basename(file)}`);
          const head = getParsedSession(this.parseSessionHeadResult(file, projectDir));
          perf.end(parseMarker);

          if (head) {
            heads.push(head);
            this.sessionMetaMap.set(head.id, {
              id: head.id,
              title: head.title,
              sourcePath: file,
              directory: head.directory,
              model: head.stats.total_tokens ? "unknown" : undefined,
              messageCount: head.stats.message_count,
              createdAt: head.time_created,
              updatedAt: head.time_updated ?? head.time_created,
            });
          }
        } catch {
          // skip malformed files
        }
      }
    }

    perf.end(scanMarker);
    return heads;
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.sessionMetaMap;
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    this.sessionMetaMap = meta as Map<string, SessionMeta>;
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
    const messages: Message[] = [];
    const pendingToolCalls = new Map<string, [number, number]>();
    const ignoredToolCallIds = new Set<string>();
    const assistantUuidToToolCalls = new Map<string, string[]>();
    const assistantState = {
      currentIndex: null as number | null,
      latestTextIndex: null as number | null,
    };

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;

    for (const record of parseJsonlLines(content)) {
      try {
        this.convertRecord(
          record,
          messages,
          pendingToolCalls,
          ignoredToolCallIds,
          assistantUuidToToolCalls,
          assistantState,
        );
      } catch {
        // skip malformed records
      }
    }

    const cleanedMessages = cleanParsedMessages(messages);

    for (const msg of cleanedMessages) {
      totalCost += msg.cost ?? 0;
      totalInputTokens += msg.tokens?.input ?? 0;
      totalOutputTokens += msg.tokens?.output ?? 0;
      totalCacheRead += msg.tokens?.cache_read ?? 0;
      totalCacheCreate += msg.tokens?.cache_create ?? 0;
    }

    return {
      id: meta.id,
      title: meta.title,
      slug: `claudecode/${meta.id}`,
      directory: meta.directory,
      version: undefined,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: {
        message_count: cleanedMessages.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
        total_cache_read_tokens: totalCacheRead,
        total_cache_create_tokens: totalCacheCreate,
      },
      messages: cleanedMessages,
    };
  }

  /**
   * 检测文件系统变更
   * 通过比较文件修改时间判断是否有新内容
   */
  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    if (!this.basePath) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    const now = Date.now();
    const changedIds = new Set<string>();
    const recentSessions = cachedSessions.filter(
      (session) => now - session.time_created <= RECENT_SESSION_REVALIDATION_WINDOW_MS,
    );

    for (const session of recentSessions) {
      changedIds.add(session.id);
      const meta = this.sessionMetaMap.get(session.id);
      if (!meta) continue;
      delete this.sessionsIndexCache[basename(dirname(meta.sourcePath))];
    }

    for (const session of cachedSessions) {
      const meta = this.sessionMetaMap.get(session.id);
      if (!meta) {
        changedIds.add(session.id);
        continue;
      }

      try {
        const stat = statSync(meta.sourcePath);
        // 如果文件修改时间晚于缓存时间，说明有变更
        if (stat.mtimeMs > sinceTimestamp) {
          changedIds.add(session.id);
        }
      } catch {
        // 文件可能被删除，也视为变更
        changedIds.add(session.id);
      }
    }

    // 检查是否有新文件（简单实现：比较缓存数量和实际文件数量）
    try {
      let totalFiles = 0;
      for (const dir of this.listProjectDirs()) {
        totalFiles += this.listJsonlFiles(dir).length;
      }
      const hasNewFiles = totalFiles > cachedSessions.length;

      return {
        hasChanges: changedIds.size > 0 || hasNewFiles,
        changedIds: Array.from(changedIds),
        timestamp: Date.now(),
      };
    } catch {
      return {
        hasChanges: changedIds.size > 0,
        changedIds: Array.from(changedIds),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 增量扫描 - 只扫描变更的会话
   */
  incrementalScan(cachedSessions: SessionHead[], changedIds: string[]): SessionHead[] {
    if (!this.basePath) return cachedSessions;

    // 创建缓存会话的 Map 便于更新
    const sessionMap = new Map(cachedSessions.map((s) => [s.id, s]));

    // 重新扫描变更的会话
    for (const projectDir of this.listProjectDirs()) {
      for (const file of this.listJsonlFiles(projectDir)) {
        try {
          const sessionId = basename(file, ".jsonl");

          // 只处理变更的会话
          if (changedIds.includes(sessionId)) {
            const head = getParsedSession(this.parseSessionHeadResult(file, projectDir));
            if (head) {
              sessionMap.set(head.id, head);
              this.sessionMetaMap.set(head.id, {
                id: head.id,
                title: head.title,
                sourcePath: file,
                directory: head.directory,
                model: head.stats.total_tokens ? "unknown" : undefined,
                messageCount: head.stats.message_count,
                createdAt: head.time_created,
                updatedAt: head.time_updated ?? head.time_created,
              });
            }
          }
        } catch {
          // skip malformed files
        }
      }
    }

    // 检查是否有新文件需要添加
    for (const projectDir of this.listProjectDirs()) {
      for (const file of this.listJsonlFiles(projectDir)) {
        try {
          const sessionId = basename(file, ".jsonl");
          if (!sessionMap.has(sessionId)) {
            const head = getParsedSession(this.parseSessionHeadResult(file, projectDir));
            if (head) {
              sessionMap.set(head.id, head);
              this.sessionMetaMap.set(head.id, {
                id: head.id,
                title: head.title,
                sourcePath: file,
                directory: head.directory,
                model: head.stats.total_tokens ? "unknown" : undefined,
                messageCount: head.stats.message_count,
                createdAt: head.time_created,
                updatedAt: head.time_updated ?? head.time_created,
              });
            }
          }
        } catch {
          // skip malformed files
        }
      }
    }

    return Array.from(sessionMap.values());
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

  private loadSessionsIndex(projectDir: string): Map<string, Record<string, unknown>> {
    const cacheKey = basename(projectDir);
    if (cacheKey in this.sessionsIndexCache) {
      return this.sessionsIndexCache[cacheKey];
    }

    const indexPath = join(projectDir, "sessions-index.json");
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
            const usage = (msg as Record<string, unknown>)["usage"] as
              | Record<string, unknown>
              | undefined;
            if (usage && typeof usage === "object") {
              const inputTokens = (usage["input_tokens"] as number) ?? 0;
              const cacheRead = (usage["cache_read_input_tokens"] as number) ?? 0;
              const cacheCreate = (usage["cache_creation_input_tokens"] as number) ?? 0;
              const outputTokens = (usage["output_tokens"] as number) ?? 0;

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
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    ignoredToolCallIds: Set<string>,
    assistantUuidToToolCalls: Map<string, string[]>,
    assistantState: { currentIndex: number | null; latestTextIndex: number | null },
  ): void {
    if (data["isMeta"] === true) return;

    const msgType = String(data["type"] ?? "");
    if (isInternalEventType(msgType)) return;

    if (msgType === "assistant") {
      this.convertAssistantRecord(
        data,
        messages,
        pendingToolCalls,
        ignoredToolCallIds,
        assistantUuidToToolCalls,
        assistantState,
      );
    } else if (msgType === "user") {
      this.convertUserRecord(
        data,
        messages,
        pendingToolCalls,
        ignoredToolCallIds,
        assistantUuidToToolCalls,
        assistantState,
      );
    } else if (msgType === "tool_result") {
      this.convertToolResultRecord(data, messages, assistantState);
    }
  }

  private convertAssistantRecord(
    data: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    ignoredToolCallIds: Set<string>,
    assistantUuidToToolCalls: Map<string, string[]>,
    assistantState: { currentIndex: number | null; latestTextIndex: number | null },
  ): void {
    const msg = (data["message"] ?? {}) as Record<string, unknown>;
    const timestampMs = parseTimestampMs(data);
    const rawContent = (msg["content"] ?? []) as unknown[];
    const uuid = String(data["uuid"] ?? "");

    const toolCallIds: string[] = [];
    let currentAssistantIndex = assistantState.currentIndex;
    let latestAssistantTextIndex = assistantState.latestTextIndex;

    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (!item || typeof item !== "object") continue;
        const part = item as Record<string, unknown>;
        const partType = String(part["type"] ?? "");

        if (partType === "thinking") {
          const text = cleanInternalText(String(part["thinking"] ?? ""));
          if (text) {
            currentAssistantIndex = this.appendAssistantReasoning(
              messages,
              { messageId: uuid, msg, timestampMs, text },
              currentAssistantIndex,
            );
          }
          continue;
        }

        if (partType === "text") {
          const text = cleanInternalText(String(part["text"] ?? ""));
          if (text) {
            currentAssistantIndex = this.appendAssistantText(
              messages,
              { messageId: uuid, msg, timestampMs, text },
              currentAssistantIndex,
            );
            latestAssistantTextIndex = currentAssistantIndex;
          }
          continue;
        }

        if (partType !== "tool_use") continue;

        const toolName = String(part["name"] ?? "").trim();
        const toolCallId = String(part["id"] ?? "").trim();

        if (toolName && toolCallId && this.shouldIgnoreTool(toolName)) {
          ignoredToolCallIds.add(toolCallId);
          continue;
        }

        const toolPart = this.buildToolPart(part, timestampMs);
        const [msgIndex, partIndex] = this.attachToolCallToLatestAssistant(messages, {
          messageId: uuid,
          msg,
          timestampMs,
          toolPart,
          latestTextIndex: latestAssistantTextIndex,
        });
        currentAssistantIndex = msgIndex;
        if (toolCallId) {
          pendingToolCalls.set(toolCallId, [msgIndex, partIndex]);
          toolCallIds.push(toolCallId);
        }
      }
    }

    if (toolCallIds.length > 0) {
      assistantUuidToToolCalls.set(uuid, toolCallIds);
    }

    assistantState.currentIndex = currentAssistantIndex;
    assistantState.latestTextIndex = latestAssistantTextIndex;
  }

  private convertUserRecord(
    data: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    ignoredToolCallIds: Set<string>,
    assistantUuidToToolCalls: Map<string, string[]>,
    assistantState: { currentIndex: number | null; latestTextIndex: number | null },
  ): void {
    const msg = (data["message"] ?? {}) as Record<string, unknown>;
    const timestampMs = parseTimestampMs(data);
    const content = msg["content"] ?? "";
    const uuid = String(data["uuid"] ?? "");

    // String content — simple user message
    if (typeof content === "string") {
      const parts = this.normalizeUserTextParts(content, timestampMs);
      if (parts.length === 0) {
        assistantState.currentIndex = null;
        assistantState.latestTextIndex = null;
        return;
      }
      messages.push(this.buildMessage({ messageId: uuid, role: "user", timestampMs, parts }));
      assistantState.currentIndex = null;
      assistantState.latestTextIndex = null;
      return;
    }

    if (!Array.isArray(content)) {
      assistantState.currentIndex = null;
      assistantState.latestTextIndex = null;
      return;
    }

    const visibleParts = this.normalizeUserTextParts(content, timestampMs);
    const toolStateUpdates = this.extractToolStateUpdates(data["toolUseResult"]);

    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const ci = item as Record<string, unknown>;
      if (ci["type"] !== "tool_result") continue;

      const toolCallId = this.resolveToolCallId(data, ci, assistantUuidToToolCalls);
      if (toolCallId && ignoredToolCallIds.has(toolCallId)) continue;

      const outputParts = this.normalizeClaudeToolOutput(ci["content"], timestampMs);
      if (
        this.backfillToolOutput(
          messages,
          pendingToolCalls,
          toolCallId,
          outputParts,
          toolStateUpdates,
        )
      ) {
        continue;
      }

      const fallback = this.buildFallbackToolMessage({
        messageId: uuid,
        timestampMs,
        toolCallId,
        outputParts,
      });
      if (fallback) messages.push(fallback);
    }

    if (visibleParts.length > 0) {
      messages.push(
        this.buildMessage({ messageId: uuid, role: "user", timestampMs, parts: visibleParts }),
      );
    }

    assistantState.currentIndex = null;
    assistantState.latestTextIndex = null;
  }

  private convertToolResultRecord(
    data: Record<string, unknown>,
    messages: Message[],
    assistantState: { currentIndex: number | null; latestTextIndex: number | null },
  ): void {
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
    if (fallback) messages.push(fallback);

    assistantState.currentIndex = null;
    assistantState.latestTextIndex = null;
  }

  // --- Message building ---

  private buildMessage(opts: {
    messageId: string;
    role: string;
    timestampMs: number;
    parts: MessagePart[];
    agent?: string;
    mode?: string;
    model?: string | null;
    provider?: string | null;
    tokens?: Record<string, unknown>;
    cost?: number;
    cost_source?: Message["cost_source"];
  }): Message {
    return {
      id: opts.messageId,
      role: opts.role as Message["role"],
      agent: opts.agent ?? null,
      time_created: opts.timestampMs,
      mode: opts.mode ?? null,
      model: opts.model ?? null,
      provider: opts.provider ?? null,
      tokens: opts.tokens ? (opts.tokens as Message["tokens"]) : undefined,
      cost: opts.cost ?? 0,
      cost_source: opts.cost_source,
      parts: opts.parts,
    };
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

  private applyAssistantMetadata(message: Message, msg: Record<string, unknown>): void {
    const model = msg["model"];
    if (model && typeof model === "string" && !message.model) {
      message.model = model;
    }
    const usage = msg["usage"];
    if (usage && typeof usage === "object" && !message.tokens) {
      const u = usage as Record<string, unknown>;
      const cacheRead = (u["cache_read_input_tokens"] as number) ?? 0;
      const cacheCreate = (u["cache_creation_input_tokens"] as number) ?? 0;
      message.tokens = {
        input: ((u["input_tokens"] as number) ?? 0) + cacheCreate + cacheRead,
        output: (u["output_tokens"] as number) ?? 0,
        cache_read: cacheRead,
        cache_create: cacheCreate,
      };
      const cost = estimateTokenCost(message.model, message.tokens);
      if (cost !== null) {
        message.cost = cost;
        message.cost_source = "estimated";
      }
    }
  }

  // --- Assistant message grouping ---

  private appendAssistantReasoning(
    messages: Message[],
    opts: { messageId: string; msg: Record<string, unknown>; timestampMs: number; text: string },
    currentIndex: number | null,
  ): number {
    const part = this.buildReasoningPart(opts.text, opts.timestampMs);

    if (currentIndex !== null) {
      const message = messages[currentIndex]!;
      const hasText = message.parts.some((p) => p.type === "text");
      const hasTool = message.parts.some((p) => p.type === "tool");
      if (!hasText && !hasTool) {
        this.appendPartIfNew(message, part);
        this.applyAssistantMetadata(message, opts.msg);
        return currentIndex;
      }
    }

    const message = this.buildMessage({
      messageId: opts.messageId,
      role: "assistant",
      timestampMs: opts.timestampMs,
      parts: [part],
      agent: "claude",
    });
    this.applyAssistantMetadata(message, opts.msg);
    messages.push(message);
    return messages.length - 1;
  }

  private appendAssistantText(
    messages: Message[],
    opts: { messageId: string; msg: Record<string, unknown>; timestampMs: number; text: string },
    currentIndex: number | null,
  ): number {
    const part = this.buildTextPart(opts.text, opts.timestampMs);

    if (currentIndex !== null) {
      const message = messages[currentIndex]!;
      const hasTool = message.parts.some((p) => p.type === "tool");
      if (!hasTool) {
        this.appendPartIfNew(message, part);
        this.applyAssistantMetadata(message, opts.msg);
        return currentIndex;
      }
    }

    const message = this.buildMessage({
      messageId: opts.messageId,
      role: "assistant",
      timestampMs: opts.timestampMs,
      parts: [part],
      agent: "claude",
    });
    this.applyAssistantMetadata(message, opts.msg);
    messages.push(message);
    return messages.length - 1;
  }

  private attachToolCallToLatestAssistant(
    messages: Message[],
    opts: {
      messageId: string;
      msg: Record<string, unknown>;
      timestampMs: number;
      toolPart: MessagePart;
      latestTextIndex: number | null;
    },
  ): [number, number] {
    if (opts.latestTextIndex !== null) {
      const message = messages[opts.latestTextIndex]!;
      message.parts.push(opts.toolPart);
      this.applyAssistantMetadata(message, opts.msg);
      return [opts.latestTextIndex, message.parts.length - 1];
    }

    const message = this.buildMessage({
      messageId: opts.messageId,
      role: "assistant",
      timestampMs: opts.timestampMs,
      parts: [opts.toolPart],
      agent: "claude",
      mode: "tool",
    });
    this.applyAssistantMetadata(message, opts.msg);
    messages.push(message);
    return [messages.length - 1, 0];
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
          const text = String(
            (item as Record<string, unknown>)["text"] ??
              (item as Record<string, unknown>)["content"] ??
              "",
          );
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
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    callId: string,
    outputParts: MessagePart[],
    stateUpdates?: Record<string, unknown>,
  ): boolean {
    if (!callId) return false;

    const location = pendingToolCalls.get(callId);
    if (location === undefined) return false;

    const [msgIndex, partIndex] = location;
    const state =
      messages[msgIndex]!.parts[partIndex]!.state ??
      (messages[msgIndex]!.parts[partIndex]!.state = {});

    if (outputParts.length > 0) {
      const existing = state.output;
      if (Array.isArray(existing)) {
        existing.push(...outputParts);
      } else if (existing === null || existing === undefined) {
        state.output = [...outputParts];
      } else {
        state.output = [existing, ...outputParts];
      }
    }

    if (stateUpdates) {
      Object.assign(state, stateUpdates);
    }

    if (outputParts.length > 0 && !state.status) {
      state.status = "completed";
    }

    return outputParts.length > 0 || !!stateUpdates;
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
  }): Message | null {
    if (opts.outputParts.length === 0) return null;
    return this.buildMessage({
      messageId: opts.messageId,
      role: "tool",
      timestampMs: opts.timestampMs,
      parts: opts.outputParts,
    });
  }

  // --- Utilities ---

  private shouldIgnoreTool(toolName: string): boolean {
    return toolName === "TodoWrite";
  }

  private appendPartIfNew(message: Message, part: MessagePart): void {
    const parts = message.parts;
    if (parts.length > 0 && parts[parts.length - 1]!.type === part.type) {
      // Skip if identical to tail part (streaming dedup)
      const tail = parts[parts.length - 1]!;
      if (tail.text === part.text) return;
    }
    parts.push(part);
  }
}
