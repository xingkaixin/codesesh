import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  BaseAgent,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  skippedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ChangeCheckResult,
  ParseSessionResult,
  SessionCacheMeta,
} from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { parseJsonlLines } from "../utils/jsonl.js";
import { normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText, cleanParsedMessages } from "../utils/session-normalization.js";
import { perf } from "../utils/perf.js";
import { estimateTokenCost } from "../utils/cost.js";

const KIMI_TOOL_TITLE_MAP: Record<string, string> = {
  ReadFile: "read",
  Glob: "glob",
  StrReplaceFile: "edit",
  Grep: "grep",
  WriteFile: "write",
  Shell: "bash",
};

const KIMI_IGNORED_TOOLS = new Set(["SetTodoList"]);

function mapToolTitle(toolName: string): string {
  return KIMI_TOOL_TITLE_MAP[toolName] ?? toolName;
}

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  cwd: string;
  contextFile: string | null;
  wireFile: string | null;
  createdAt: number;
  metaFile: string;
}

interface KimiWorkDir {
  path: string;
  last_session_id: string | null;
}

function normalizeToolArguments(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function normalizeToolOutputParts(content: unknown, timestampMs: number): MessagePart[] {
  if (typeof content === "string") {
    const text = cleanInternalText(content);
    return text ? [{ type: "text" as const, text, time_created: timestampMs }] : [];
  }
  if (Array.isArray(content)) {
    const parts: MessagePart[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null && "text" in item) {
        const text = String((item as Record<string, unknown>).text ?? "");
        const cleaned = cleanInternalText(text);
        if (cleaned) parts.push({ type: "text", text: cleaned, time_created: timestampMs });
      } else if (typeof item === "string") {
        const text = cleanInternalText(item);
        if (text) parts.push({ type: "text", text, time_created: timestampMs });
      }
    }
    return parts;
  }
  if (content == null) return [];
  const text = cleanInternalText(String(content));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

function normalizeWireToolOutputParts(returnValue: unknown, timestampMs: number): MessagePart[] {
  if (returnValue == null) return [];
  if (typeof returnValue === "string") {
    const text = cleanInternalText(returnValue);
    return text ? [{ type: "text" as const, text, time_created: timestampMs }] : [];
  }
  if (typeof returnValue === "object") {
    const text = cleanInternalText(JSON.stringify(returnValue, null, 2));
    return text ? [{ type: "text", text, time_created: timestampMs }] : [];
  }
  const text = cleanInternalText(String(returnValue));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

function kimiContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        return String(record.text ?? record.content ?? "");
      }
      return "";
    })
    .join(" ");
}

function extractFirstUserTitle(contextFile: string | null, wireFile: string | null): string | null {
  if (contextFile && existsSync(contextFile)) {
    const content = readFileSync(contextFile, "utf-8");
    for (const record of parseJsonlLines(content)) {
      if (record.role !== "user") continue;
      const title = normalizeTitleText(kimiContentText(record.content));
      if (title) return title;
    }
  }

  if (wireFile && existsSync(wireFile)) {
    const content = readFileSync(wireFile, "utf-8");
    for (const record of parseJsonlLines(content)) {
      const message = (record.message ?? {}) as Record<string, unknown>;
      if (message.type !== "TurnBegin") continue;
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      const userInput = payload.user_input;
      if (!Array.isArray(userInput)) continue;
      const title = normalizeTitleText(kimiContentText(userInput));
      if (title) return title;
    }
  }

  return null;
}

export class KimiAgent extends BaseAgent {
  readonly name = "kimi";
  readonly displayName = "Kimi-Cli";

  private basePath: string | null = null;
  private sessionMetaMap = new Map<string, SessionMeta>();
  private projectMap = new Map<string, string>();
  private defaultModel: string | null = null;

  private findBasePath(): string | null {
    const roots = resolveProviderRoots();
    return firstExisting(join(roots.kimiRoot, "sessions"), "data/kimi");
  }

  /** Parse kimi.json and build md5(project_path) → cwd mapping */
  private loadKimiConfig(): void {
    const roots = resolveProviderRoots();
    const configPath = join(roots.kimiRoot, "kimi.json");
    const tomlPath = join(roots.kimiRoot, "config.toml");
    if (existsSync(tomlPath)) {
      const configText = readFileSync(tomlPath, "utf-8");
      this.defaultModel = configText.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    }
    if (!existsSync(configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const workDirs = raw?.work_dirs;
      if (!Array.isArray(workDirs)) return;
      for (const wd of workDirs) {
        const path = (wd as KimiWorkDir).path;
        if (typeof path !== "string") continue;
        const hash = createHash("md5").update(path).digest("hex");
        this.projectMap.set(hash, path);
      }
    } catch {
      // ignore malformed config
    }
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    this.loadKimiConfig();
    try {
      return this.listSessionDirs().length > 0;
    } catch {
      // ignore
    }
    return false;
  }

  /** Walk sessions/{project_hash}/{session_id}/ and find valid session dirs */
  private listSessionDirs(): string[] {
    if (!this.basePath) return [];
    const dirs: string[] = [];
    try {
      for (const hashEntry of readdirSync(this.basePath, { withFileTypes: true })) {
        if (!hashEntry.isDirectory()) continue;
        const hashPath = join(this.basePath, hashEntry.name);
        try {
          for (const sessionEntry of readdirSync(hashPath, { withFileTypes: true })) {
            if (!sessionEntry.isDirectory()) continue;
            const sessionPath = join(hashPath, sessionEntry.name);
            if (
              existsSync(join(sessionPath, "metadata.json")) ||
              existsSync(join(sessionPath, "state.json"))
            ) {
              dirs.push(sessionPath);
            }
          }
        } catch {
          // skip unreadable hash dirs
        }
      }
    } catch {
      // skip unreadable base
    }
    return dirs;
  }

  /** Parse session directory, preferring state.json over metadata.json */
  private parseSessionDir(sessionDir: string): SessionMeta | null {
    return getParsedSession(this.parseSessionDirResult(sessionDir));
  }

  private parseSessionDirResult(sessionDir: string): ParseSessionResult<SessionMeta> {
    try {
      const sessionId = basename(sessionDir);
      const projectHash = basename(dirname(sessionDir));
      const contextFile = join(sessionDir, "context.jsonl");
      const wireFile = join(sessionDir, "wire.jsonl");

      if (!existsSync(contextFile) && !existsSync(wireFile)) {
        return skippedSession("missing transcript");
      }

      const statePath = join(sessionDir, "state.json");
      const metaPath = join(sessionDir, "metadata.json");

      let title = "";
      let wireMtime: number | null = null;
      let metaFile = "";

      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
        title = String(state.custom_title ?? "");
        wireMtime = typeof state.wire_mtime === "number" ? state.wire_mtime : null;
        metaFile = statePath;
      } else if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
        title = String(meta.title ?? "");
        wireMtime = typeof meta.wire_mtime === "number" ? meta.wire_mtime : null;
        metaFile = metaPath;
      }

      const cwd = this.projectMap.get(projectHash) || "";
      const existingContextFile = existsSync(contextFile) ? contextFile : null;
      const existingWireFile = existsSync(wireFile) ? wireFile : null;
      const messageTitle = extractFirstUserTitle(existingContextFile, existingWireFile);
      const createdAt =
        wireMtime !== null
          ? wireMtime * 1000
          : metaFile
            ? statSync(metaFile).mtimeMs
            : statSync(sessionDir).mtimeMs;

      return parsedSession({
        id: sessionId,
        title: resolveSessionTitle(title, messageTitle, null),
        sourcePath: sessionDir,
        cwd,
        contextFile: existingContextFile,
        wireFile: existingWireFile,
        createdAt,
        metaFile,
      });
    } catch {
      return skippedSession("malformed metadata");
    }
  }

  scan(options?: AgentScanOptions): SessionHead[] {
    if (!this.basePath) return [];

    const scanMarker = perf.start("kimi:scan");

    const listMarker = perf.start("listSessionDirs");
    const sessionDirs = this.listSessionDirs();
    perf.end(listMarker);

    const heads: SessionHead[] = [];
    for (const dir of sessionDirs) {
      try {
        const parseMarker = perf.start(`parseSessionDir:${basename(dir)}`);
        const meta = getParsedSession(this.parseSessionDirResult(dir));
        perf.end(parseMarker);

        if (!meta) continue;
        if (!matchesScanWindow(meta.createdAt, options)) continue;

        this.sessionMetaMap.set(meta.id, meta);
        const stats = this.extractStats(meta.sourcePath);
        heads.push({
          id: meta.id,
          slug: `kimi/${meta.id}`,
          title: meta.title,
          directory: meta.cwd,
          time_created: meta.createdAt,
          time_updated: meta.createdAt,
          stats,
        });
      } catch {
        // skip
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

  /**
   * 检测文件系统变更
   */
  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const changedIds = new Set<string>();
    const cachedIds = new Set(cachedSessions.map((session) => session.id));
    const currentIds = new Set<string>();

    for (const dir of this.listSessionDirs()) {
      const meta = getParsedSession(this.parseSessionDirResult(dir));
      if (!meta) continue;

      currentIds.add(meta.id);
      this.sessionMetaMap.set(meta.id, meta);

      if (!cachedIds.has(meta.id)) {
        changedIds.add(meta.id);
        continue;
      }

      const dataFile = meta.wireFile || meta.contextFile;
      try {
        const metaStat = statSync(meta.metaFile);
        if (metaStat.mtimeMs > sinceTimestamp) {
          changedIds.add(meta.id);
          continue;
        }
        if (dataFile) {
          const dataStat = statSync(dataFile);
          if (dataStat.mtimeMs > sinceTimestamp) {
            changedIds.add(meta.id);
          }
        }
      } catch {
        changedIds.add(meta.id);
      }
    }

    for (const session of cachedSessions) {
      if (!currentIds.has(session.id)) changedIds.add(session.id);
    }

    const changedIdList = Array.from(changedIds);
    return {
      hasChanges: changedIdList.length > 0,
      changedIds: changedIdList,
      timestamp: Date.now(),
    };
  }

  /**
   * 增量扫描
   */
  incrementalScan(cachedSessions: SessionHead[], changedIds: string[]): SessionHead[] {
    const sessionMap = new Map(cachedSessions.map((s) => [s.id, s]));
    const changedIdSet = new Set(changedIds);

    for (const id of changedIdSet) {
      sessionMap.delete(id);
      this.sessionMetaMap.delete(id);
    }

    for (const dir of this.listSessionDirs()) {
      try {
        const meta = getParsedSession(this.parseSessionDirResult(dir));
        if (!meta) continue;

        if (changedIdSet.has(meta.id)) {
          this.sessionMetaMap.set(meta.id, meta);
          const stats = this.extractStats(meta.sourcePath);
          sessionMap.set(meta.id, {
            id: meta.id,
            slug: `kimi/${meta.id}`,
            title: meta.title,
            directory: meta.cwd,
            time_created: meta.createdAt,
            time_updated: meta.createdAt,
            stats,
          });
        }
      } catch {
        // skip
      }
    }

    return Array.from(sessionMap.values());
  }

  getSessionData(sessionId: string): SessionData {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    if (meta.contextFile) {
      return this.getSessionDataFromContext(meta);
    }
    return this.getSessionDataFromWire(meta);
  }

  private getSessionDataFromContext(meta: SessionMeta): SessionData {
    if (!meta.contextFile) throw new Error("context.jsonl is missing");

    const content = readFileSync(meta.contextFile, "utf-8");
    const messages: Message[] = [];
    const pendingToolCalls = new Map<string, [number, number]>();
    const ignoredToolCallIds = new Set<string>();

    let seq = 0;
    const fallbackTs = meta.createdAt;
    for (const record of parseJsonlLines(content)) {
      seq++;
      try {
        const role = String(record.role ?? "");
        if (role === "_checkpoint" || role === "_usage" || isInternalEventType(role)) continue;

        if (role === "user") {
          const text = cleanInternalText(kimiContentText(record.content));
          if (text) {
            messages.push(
              this.buildMessage({
                messageId: `context-${seq}`,
                role: "user",
                timestampMs: fallbackTs,
                parts: [{ type: "text", text, time_created: fallbackTs }],
              }),
            );
          }
          continue;
        }

        if (role === "assistant") {
          const { message, toolIndexes } = this.buildContextAssistantMessage(
            record,
            seq,
            ignoredToolCallIds,
            fallbackTs,
          );
          if (!message) continue;
          const msgIndex = messages.length;
          messages.push(message);
          for (const [callId, partIndex] of toolIndexes) {
            pendingToolCalls.set(callId, [msgIndex, partIndex]);
          }
          continue;
        }

        if (role === "tool") {
          const callId = String(record.tool_call_id ?? "").trim();
          if (callId && ignoredToolCallIds.has(callId)) continue;
          const outputParts = normalizeToolOutputParts(record.content, fallbackTs);
          if (callId && this.backfillToolOutput(messages, pendingToolCalls, callId, outputParts)) {
            continue;
          }
          if (outputParts.length > 0) {
            messages.push(
              this.buildMessage({
                messageId: `context-${seq}`,
                role: "tool",
                timestampMs: fallbackTs,
                parts: outputParts,
              }),
            );
          }
        }
      } catch {
        // skip
      }
    }

    const stats = this.extractStats(meta.sourcePath);
    return this.buildSessionData(meta, messages, stats);
  }

  private getSessionDataFromWire(meta: SessionMeta): SessionData {
    const wirePath = meta.wireFile ?? join(meta.sourcePath, "wire.jsonl");
    if (!existsSync(wirePath)) throw new Error("wire.jsonl is missing");

    const content = readFileSync(wirePath, "utf-8");
    const messages: Message[] = [];
    const pendingToolCalls = new Map<string, [number, number]>();
    const ignoredToolCallIds = new Set<string>();
    const openToolArgumentBuffer = new Map<string, string>();

    let currentAssistantIndex: number | null = null;
    let openToolCallId: string | null = null;
    let seq = 0;

    for (const record of parseJsonlLines(content)) {
      seq++;
      try {
        const message = (record.message ?? {}) as Record<string, unknown>;
        const msgType = String(message.type ?? "");
        if (isInternalEventType(msgType)) continue;
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        const timestamp = Number(record.timestamp ?? 0);
        const timestampMs = Number.isFinite(timestamp) ? Math.floor(timestamp * 1000) : 0;

        // Bind usage to the most recent assistant message without tokens
        const usage = message["usage"] as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          const inputTokens = Number(usage["input_tokens"] ?? 0);
          const outputTokens = Number(usage["output_tokens"] ?? 0);
          if (inputTokens || outputTokens) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i]!;
              if (msg.role === "assistant" && !msg.tokens) {
                msg.tokens = { input: inputTokens, output: outputTokens };
                msg.model ??= this.defaultModel;
                const cost = estimateTokenCost(msg.model, msg.tokens);
                if (cost !== null) {
                  msg.cost = cost;
                  msg.cost_source = "estimated";
                }
                break;
              }
            }
          }
        }

        if (msgType === "TurnBegin") {
          const userInput = payload.user_input;
          if (Array.isArray(userInput) && userInput.length > 0) {
            const text = cleanInternalText(kimiContentText(userInput));
            if (text) {
              messages.push(
                this.buildMessage({
                  messageId: `wire-${seq}`,
                  role: "user",
                  timestampMs,
                  parts: [{ type: "text", text, time_created: timestampMs }],
                }),
              );
            }
          }
          currentAssistantIndex = null;
          openToolCallId = null;
          continue;
        }

        if (msgType === "ContentPart") {
          currentAssistantIndex = this.getOrCreateWireAssistant(
            messages,
            currentAssistantIndex,
            `wire-${seq}`,
          );
          const assistant = messages[currentAssistantIndex]!;
          const partType = String(payload.type ?? "");
          if (partType === "think") {
            const text = cleanInternalText(String(payload.think ?? ""));
            if (text) {
              assistant.parts.push({ type: "reasoning", text, time_created: timestampMs });
            }
          } else if (partType === "text") {
            const text = cleanInternalText(String(payload.text ?? ""));
            if (text) {
              assistant.parts.push({ type: "text", text, time_created: timestampMs });
            }
          }
          continue;
        }

        if (msgType === "ToolCall") {
          const function_ = payload.function as Record<string, unknown> | undefined;
          const toolName = String(function_?.name ?? "").trim();
          const callId = String(payload.id ?? "").trim();

          if (toolName && callId && KIMI_IGNORED_TOOLS.has(toolName)) {
            ignoredToolCallIds.add(callId);
            openToolCallId = callId;
            continue;
          }

          if (!function_ || !callId || !toolName) continue;

          currentAssistantIndex = this.getOrCreateWireAssistant(
            messages,
            currentAssistantIndex,
            `wire-${seq}`,
          );
          const assistant = messages[currentAssistantIndex]!;

          const rawArgs = function_.arguments;
          const normalizedArgs = normalizeToolArguments(rawArgs);
          const buffer =
            typeof rawArgs === "string" && typeof normalizedArgs !== "string" ? rawArgs : null;

          const toolPart: MessagePart = {
            type: "tool",
            tool: toolName,
            callID: callId,
            title: mapToolTitle(toolName),
            state: { arguments: normalizedArgs, output: null },
            time_created: timestampMs,
          };

          const partIndex = assistant.parts.length;
          assistant.parts.push(toolPart);
          assistant.mode = "tool";
          pendingToolCalls.set(callId, [currentAssistantIndex, partIndex]);
          openToolCallId = callId;

          if (buffer !== null) {
            openToolArgumentBuffer.set(callId, buffer);
          }
          continue;
        }

        if (msgType === "ToolCallPart") {
          if (openToolCallId && ignoredToolCallIds.has(openToolCallId)) continue;
          const argumentsPart = String(payload.arguments_part ?? "");
          this.appendWireToolCallPart(
            argumentsPart,
            openToolCallId,
            openToolArgumentBuffer,
            messages,
            pendingToolCalls,
          );
          continue;
        }

        if (msgType === "ToolResult") {
          const callId = String(payload.tool_call_id ?? "").trim();
          if (callId && ignoredToolCallIds.has(callId)) continue;
          const outputParts = normalizeWireToolOutputParts(payload.return_value, timestampMs);
          if (callId && this.backfillToolOutput(messages, pendingToolCalls, callId, outputParts)) {
            continue;
          }
          if (outputParts.length > 0) {
            messages.push(
              this.buildMessage({
                messageId: `wire-${seq}`,
                role: "tool",
                timestampMs,
                parts: outputParts,
              }),
            );
          }
          continue;
        }

        // Skip StepBegin, StatusUpdate, ApprovalRequest, ApprovalResponse, TurnEnd
      } catch {
        // skip
      }
    }

    // Filter out messages with empty parts
    const filteredMessages = messages.filter((m) => m.parts.length > 0);
    const stats = this.extractStats(meta.sourcePath);
    return this.buildSessionData(meta, filteredMessages, stats);
  }

  // --- Helpers ---

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
      parts: opts.parts,
    };
  }

  private buildContextAssistantMessage(
    record: Record<string, unknown>,
    seq: number,
    ignoredToolCallIds: Set<string>,
    fallbackTs: number,
  ): { message: Message; toolIndexes: Map<string, number> } {
    const parts: MessagePart[] = [];
    const toolIndexes = new Map<string, number>();

    const content = record.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        const ci = item as Record<string, unknown>;
        const partType = String(ci.type ?? "");

        if (partType === "think") {
          const text = cleanInternalText(String(ci.think ?? ""));
          if (text) parts.push({ type: "reasoning", text, time_created: fallbackTs });
        } else if (partType === "text") {
          const text = cleanInternalText(String(ci.text ?? ""));
          if (text) parts.push({ type: "text", text, time_created: fallbackTs });
        }
      }
    }

    const toolCalls = record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (typeof tc !== "object" || tc === null) continue;
        const tcRecord = tc as Record<string, unknown>;
        const function_ = tcRecord.function as Record<string, unknown> | undefined;

        if (!function_) continue;
        const toolName = String(function_.name ?? "").trim();
        const callId = String(tcRecord.id ?? "").trim();

        if (toolName && callId && KIMI_IGNORED_TOOLS.has(toolName)) {
          ignoredToolCallIds.add(callId);
          continue;
        }

        if (!toolName || !callId) continue;

        const part: MessagePart = {
          type: "tool",
          tool: toolName,
          callID: callId,
          title: mapToolTitle(toolName),
          state: { arguments: normalizeToolArguments(function_.arguments), output: null },
          time_created: fallbackTs,
        };
        toolIndexes.set(callId, parts.length);
        parts.push(part);
      }
    }

    if (parts.length === 0) {
      return {
        message: this.buildMessage({
          messageId: `context-${seq}`,
          role: "assistant",
          timestampMs: fallbackTs,
          parts: [],
        }),
        toolIndexes,
      };
    }

    const allTools = parts.every((p) => p.type === "tool");
    const message = this.buildMessage({
      messageId: `context-${seq}`,
      role: "assistant",
      timestampMs: fallbackTs,
      parts,
      agent: "kimi",
      mode: allTools ? "tool" : undefined,
    });

    return { message, toolIndexes };
  }

  private getOrCreateWireAssistant(
    messages: Message[],
    currentIndex: number | null,
    messageId: string,
  ): number {
    if (currentIndex !== null) return currentIndex;
    messages.push(
      this.buildMessage({
        messageId,
        role: "assistant",
        timestampMs: 0,
        parts: [],
        agent: "kimi",
      }),
    );
    return messages.length - 1;
  }

  private appendWireToolCallPart(
    argumentsPart: string,
    openCallId: string | null,
    buffer: Map<string, string>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
  ): void {
    if (!openCallId || !pendingToolCalls.has(openCallId)) return;

    const existing = buffer.get(openCallId) ?? "";
    const combined = existing + argumentsPart;

    try {
      const parsed = JSON.parse(combined) as unknown;
      const location = pendingToolCalls.get(openCallId);
      if (!location) return;
      const msgPart = messages[location[0]]?.parts[location[1]];
      if (msgPart?.state) {
        msgPart.state.arguments = parsed;
      }
      buffer.delete(openCallId);
    } catch {
      buffer.set(openCallId, combined);
    }
  }

  private backfillToolOutput(
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    callId: string,
    outputParts: MessagePart[],
  ): boolean {
    if (!outputParts.length || !callId) return false;

    const location = pendingToolCalls.get(callId);
    if (!location) return false;

    const part = messages[location[0]]?.parts[location[1]];
    if (!part) return false;
    if (!part.state) part.state = {};
    part.state.output = [...outputParts];
    return true;
  }

  private extractStats(sessionDir: string): SessionData["stats"] {
    let totalCost = 0;
    const stats: SessionData["stats"] = {
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      message_count: 0,
    };

    const wirePath = join(sessionDir, "wire.jsonl");
    if (!existsSync(wirePath)) return stats;

    try {
      const content = readFileSync(wirePath, "utf-8");
      for (const line of content.split("\n").filter((l) => l.trim())) {
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          const tokenUsage = (data.message as Record<string, unknown>)?.usage as
            | Record<string, unknown>
            | undefined;
          if (!tokenUsage) continue;
          const inputTokens = Number(tokenUsage.input_tokens ?? 0);
          const outputTokens = Number(tokenUsage.output_tokens ?? 0);
          stats.total_input_tokens += inputTokens;
          stats.total_output_tokens += outputTokens;
          const cost = estimateTokenCost(this.defaultModel, {
            input: inputTokens,
            output: outputTokens,
          });
          if (cost !== null) totalCost += cost;
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    // Extract total tokens from context or wire
    const contextPath = join(sessionDir, "context.jsonl");
    const rawPath = existsSync(contextPath) ? contextPath : wirePath;
    if (!existsSync(rawPath)) return stats;

    try {
      const rawContent = readFileSync(rawPath, "utf-8");
      for (const line of rawContent.split("\n").filter((l) => l.trim())) {
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          if (data.role === "_usage" && typeof data.token_count === "number") {
            stats.total_tokens = data.token_count;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    stats.total_cost = Number(totalCost.toFixed(8));
    if (stats.total_cost > 0) {
      stats.cost_source = "estimated";
    }

    return stats;
  }

  private buildSessionData(
    meta: SessionMeta,
    messages: Message[],
    stats: SessionData["stats"],
  ): SessionData {
    const cleanedMessages = cleanParsedMessages(messages);
    stats.message_count = cleanedMessages.length;
    const totalCost = cleanedMessages.reduce((sum, message) => sum + (message.cost ?? 0), 0);
    if (totalCost > 0) {
      stats.total_cost = Number(totalCost.toFixed(8));
      stats.cost_source = "estimated";
    }
    return {
      id: meta.id,
      title: meta.title,
      slug: `kimi/${meta.id}`,
      directory: meta.cwd,
      time_created: meta.createdAt,
      time_updated: meta.createdAt,
      stats,
      messages: cleanedMessages,
    };
  }
}
