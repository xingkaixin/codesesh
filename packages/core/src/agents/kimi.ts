import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  FileSystemSessionSource,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  skippedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ParseSessionResult,
  SessionCacheMeta,
  SessionSourceRef,
} from "./base.js";
import type { SessionHead, SessionDetail, MessagePart } from "../types/index.js";
import { resolveAgentRoots, firstExisting } from "../discovery/paths.js";
import { readJsonlFile } from "../utils/jsonl.js";
import { normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { estimateTokenCost } from "../utils/cost.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  narrowField,
  reportFieldMismatch,
} from "../utils/narrow.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

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

/**
 * 会话源的轻量视图：只需要目录遍历 + 小 JSON 文件（state/metadata）即可得出，
 * 不触碰 transcript。枚举路径（listSessionSources）每次刷新都会跑，只用这一层。
 */
interface SessionSource {
  id: string;
  sourcePath: string;
  cwd: string;
  contextFile: string | null;
  wireFile: string | null;
  createdAt: number;
  metaFile: string;
  explicitTitle: string;
}

interface SessionMeta extends SessionCacheMeta, SessionSource {
  title: string;
  /**
   * Mirrors createdAt, which is what listSessionSources window-filters on.
   * diffSessionSources compares this against the scan window to tell "outside
   * the window" apart from "deleted on disk"; the two must be the same quantity.
   */
  sourceMtimeMs: number;
}

/** Reads state/metadata `wire_mtime`; reports drift when the field is present but not a number. */
function readWireMtime(record: Record<string, unknown>): number | null {
  return narrowField("kimi", "session.wire_mtime", record.wire_mtime, asNumber) ?? null;
}

/** Reads a wire record's `timestamp`; reports drift when the field is present but not a number. */
function readWireTimestamp(record: Record<string, unknown>): number {
  return narrowField("kimi", "wire.timestamp", record.timestamp, asNumber) ?? 0;
}

/** Reads a token count from a usage record; reports drift when the field is present but not a number. */
function extractTokenField(usage: Record<string, unknown>, field: string): number {
  return narrowField("kimi", `usage.${field}`, usage[field], asNumber) ?? 0;
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
      const record = asRecord(item);
      if (record && "text" in record) {
        const text = String(record.text ?? "");
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
      const record = asRecord(item);
      if (record) return String(record.text ?? record.content ?? "");
      return "";
    })
    .join(" ");
}

function extractFirstUserTitle(contextFile: string | null, wireFile: string | null): string | null {
  if (contextFile && existsSync(contextFile)) {
    for (const record of readJsonlFile(contextFile)) {
      if (record.role !== "user") continue;
      const title = normalizeTitleText(kimiContentText(record.content));
      if (title) return title;
    }
  }

  if (wireFile && existsSync(wireFile)) {
    for (const record of readJsonlFile(wireFile)) {
      const message = asRecord(record.message) ?? {};
      if (message.type !== "TurnBegin") continue;
      const payload = asRecord(message.payload) ?? {};
      const userInput = payload.user_input;
      if (!Array.isArray(userInput)) continue;
      const title = normalizeTitleText(kimiContentText(userInput));
      if (title) return title;
    }
  }

  return null;
}

export class KimiAgent extends FileSystemSessionSource<SessionMeta> {
  readonly name = "kimi";
  readonly displayName = "Kimi-Cli";

  private basePath: string | null = null;
  private projectMap = new Map<string, string>();
  private defaultModel: string | null = null;

  private findBasePath(): string | null {
    const roots = resolveAgentRoots();
    return firstExisting(join(roots.kimiRoot, "sessions"), "data/kimi");
  }

  getSessionWatchPlan() {
    const roots = resolveAgentRoots();
    return {
      status: "supported" as const,
      targets: [
        { root: roots.kimiRoot, path: join(roots.kimiRoot, "sessions") },
        { path: "data/kimi" },
      ],
    };
  }

  /** Parse kimi.json and build md5(project_path) → cwd mapping */
  private loadKimiConfig(): void {
    const roots = resolveAgentRoots();
    const configPath = join(roots.kimiRoot, "kimi.json");
    const tomlPath = join(roots.kimiRoot, "config.toml");
    if (existsSync(tomlPath)) {
      const configText = readFileSync(tomlPath, "utf-8");
      this.defaultModel = configText.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    }
    if (!existsSync(configPath)) return;
    try {
      const raw = asRecord(JSON.parse(readFileSync(configPath, "utf-8")));
      const workDirs = asArray(raw?.work_dirs);
      if (!workDirs) return;
      for (const wd of workDirs) {
        const path = asString(asRecord(wd)?.path);
        if (!path) continue;
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

  /**
   * 解析会话源，优先 state.json 而非 metadata.json。
   * 只读小 JSON 文件与 statSync，不触碰 transcript——枚举路径依赖这一点。
   */
  private resolveSessionSourceResult(sessionDir: string): ParseSessionResult<SessionSource> {
    try {
      const sessionId = basename(sessionDir);
      const projectHash = basename(dirname(sessionDir));
      const contextFile = join(sessionDir, "context.jsonl");
      const wireFile = join(sessionDir, "wire.jsonl");

      const existingContextFile = existsSync(contextFile) ? contextFile : null;
      const existingWireFile = existsSync(wireFile) ? wireFile : null;
      if (!existingContextFile && !existingWireFile) {
        return skippedSession("missing transcript");
      }

      const statePath = join(sessionDir, "state.json");
      const metaPath = join(sessionDir, "metadata.json");

      let explicitTitle = "";
      let wireMtime: number | null = null;
      let metaFile = "";

      if (existsSync(statePath)) {
        const state = asRecord(JSON.parse(readFileSync(statePath, "utf-8"))) ?? {};
        explicitTitle = String(state.custom_title ?? "");
        wireMtime = readWireMtime(state);
        metaFile = statePath;
      } else if (existsSync(metaPath)) {
        const meta = asRecord(JSON.parse(readFileSync(metaPath, "utf-8"))) ?? {};
        explicitTitle = String(meta.title ?? "");
        wireMtime = readWireMtime(meta);
        metaFile = metaPath;
      }

      const createdAt =
        wireMtime !== null
          ? wireMtime * 1000
          : metaFile
            ? statSync(metaFile).mtimeMs
            : statSync(sessionDir).mtimeMs;

      return parsedSession({
        id: sessionId,
        sourcePath: sessionDir,
        cwd: this.projectMap.get(projectHash) || "",
        contextFile: existingContextFile,
        wireFile: existingWireFile,
        createdAt,
        metaFile,
        explicitTitle,
      });
    } catch {
      return skippedSession("malformed metadata");
    }
  }

  /**
   * 在会话源之上补齐 title。仅当 state/metadata 里没有可用标题时才回退去读
   * transcript 找首条用户消息，所以标题解析的成本只在真正需要重解析时付出。
   */
  private parseSessionDirResult(sessionDir: string): ParseSessionResult<SessionMeta> {
    const result = this.resolveSessionSourceResult(sessionDir);
    if (result.status !== "parsed") return result;

    const source = result.data;
    const title =
      normalizeTitleText(source.explicitTitle) ??
      resolveSessionTitle(null, extractFirstUserTitle(source.contextFile, source.wireFile), null);

    return parsedSession({ ...source, title, sourceMtimeMs: source.createdAt });
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    const refs: SessionSourceRef[] = [];
    for (const dir of this.listSessionDirs()) {
      const source = getParsedSession(this.resolveSessionSourceResult(dir));
      if (!source || !matchesScanWindow(source.createdAt, options)) continue;
      refs.push({
        sessionId: source.id,
        sourcePath: source.sourcePath,
        fingerprint: this.sourceFingerprint(source),
      });
    }
    return refs;
  }

  scanSessionSource(sourcePath: string): SessionHead | null {
    const meta = getParsedSession(this.parseSessionDirResult(sourcePath));
    if (!meta) return null;
    meta.sourceFingerprint = this.sourceFingerprint(meta);
    this.sessionMetaMap.set(meta.id, meta);
    const stats = this.extractStats(meta.sourcePath);
    return {
      id: meta.id,
      slug: `kimi/${meta.id}`,
      title: meta.title,
      directory: meta.cwd,
      time_created: meta.createdAt,
      time_updated: meta.createdAt,
      stats,
    };
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    if (meta.contextFile) {
      return this.getSessionDataFromContext(meta);
    }
    return this.getSessionDataFromWire(meta);
  }

  private getSessionDataFromContext(meta: SessionMeta): SessionDetail {
    if (!meta.contextFile) throw new Error("context.jsonl is missing");

    const builder = new TranscriptBuilder();
    const ignoredToolCallIds = new Set<string>();

    let seq = 0;
    const fallbackTs = meta.createdAt;
    for (const record of readJsonlFile(meta.contextFile)) {
      seq++;
      try {
        const role = String(record.role ?? "");
        if (role === "_checkpoint" || role === "_usage" || isInternalEventType(role)) continue;

        if (role === "user") {
          const text = cleanInternalText(kimiContentText(record.content));
          if (text) {
            builder.appendMessage({
              id: `context-${seq}`,
              role: "user",
              timestampMs: fallbackTs,
              parts: [{ type: "text", text, time_created: fallbackTs }],
            });
          }
          continue;
        }

        if (role === "assistant") {
          const message = this.buildContextAssistantMessage(
            record,
            seq,
            ignoredToolCallIds,
            fallbackTs,
          );
          if (!message) continue;
          builder.appendMessage(message);
          continue;
        }

        if (role === "tool") {
          const callId = String(record.tool_call_id ?? "").trim();
          if (callId && ignoredToolCallIds.has(callId)) continue;
          const outputParts = normalizeToolOutputParts(record.content, fallbackTs);
          if (callId && this.backfillToolOutput(builder, callId, outputParts)) {
            continue;
          }
          if (outputParts.length > 0) {
            builder.appendMessage({
              id: `context-${seq}`,
              role: "tool",
              timestampMs: fallbackTs,
              parts: outputParts,
            });
          }
        }
      } catch {
        // skip
      }
    }

    const stats = this.extractStats(meta.sourcePath);
    return this.buildSessionData(meta, builder, stats);
  }

  private getSessionDataFromWire(meta: SessionMeta): SessionDetail {
    const wirePath = meta.wireFile ?? join(meta.sourcePath, "wire.jsonl");
    if (!existsSync(wirePath)) throw new Error("wire.jsonl is missing");

    const builder = new TranscriptBuilder();
    const ignoredToolCallIds = new Set<string>();
    const openToolArgumentBuffer = new Map<string, string>();

    let openToolCallId: string | null = null;
    let seq = 0;

    for (const record of readJsonlFile(wirePath)) {
      seq++;
      try {
        const message = asRecord(record.message) ?? {};
        const msgType = asString(message.type) ?? "";
        if (isInternalEventType(msgType)) continue;
        const payload = asRecord(message.payload) ?? {};
        const timestampMs = Math.floor(readWireTimestamp(record) * 1000);

        // Bind usage to the most recent assistant message without tokens
        const usage = asRecord(message["usage"]);
        if (usage) {
          const inputTokens = extractTokenField(usage, "input_tokens");
          const outputTokens = extractTokenField(usage, "output_tokens");
          if (inputTokens || outputTokens) {
            const tokens = { input: inputTokens, output: outputTokens };
            const cost = estimateTokenCost(this.defaultModel, tokens);
            builder.attachUsageToLatestAssistant(tokens, {
              model: this.defaultModel,
              cost: cost ?? undefined,
              costSource: cost === null ? undefined : "estimated",
            });
          }
        }

        if (msgType === "TurnBegin") {
          const userInput = payload.user_input;
          if (Array.isArray(userInput) && userInput.length > 0) {
            const text = cleanInternalText(kimiContentText(userInput));
            if (text) {
              builder.appendMessage({
                id: `wire-${seq}`,
                role: "user",
                timestampMs,
                parts: [{ type: "text", text, time_created: timestampMs }],
              });
            }
          }
          builder.beginTurn();
          openToolCallId = null;
          continue;
        }

        if (msgType === "ContentPart") {
          const partType = String(payload.type ?? "");
          if (partType === "think") {
            const text = cleanInternalText(String(payload.think ?? ""));
            if (text) {
              builder.appendAssistantPart(
                { type: "reasoning", text, time_created: timestampMs },
                { id: `wire-${seq}`, timestampMs: 0, agent: "kimi" },
                { grouping: "current" },
              );
            }
          } else if (partType === "text") {
            const text = cleanInternalText(String(payload.text ?? ""));
            if (text) {
              builder.appendAssistantPart(
                { type: "text", text, time_created: timestampMs },
                { id: `wire-${seq}`, timestampMs: 0, agent: "kimi" },
                { grouping: "current" },
              );
            }
          }
          continue;
        }

        if (msgType === "ToolCall") {
          const function_ = asRecord(payload.function);
          const toolName = String(function_?.name ?? "").trim();
          const callId = String(payload.id ?? "").trim();

          if (toolName && callId && KIMI_IGNORED_TOOLS.has(toolName)) {
            ignoredToolCallIds.add(callId);
            openToolCallId = callId;
            continue;
          }

          if (!function_ || !callId || !toolName) continue;

          const rawArgs = function_.arguments;
          const normalizedArgs = normalizeToolArguments(rawArgs);
          const buffer =
            typeof rawArgs === "string" && typeof normalizedArgs !== "string" ? rawArgs : null;

          const toolPart: MessagePart = {
            type: "tool",
            tool: toolName,
            callID: callId,
            title: mapToolTitle(toolName),
            state: { status: "running", input: normalizedArgs, output: null },
            time_created: timestampMs,
          };

          builder.appendToolCall(
            toolPart,
            { id: `wire-${seq}`, timestampMs: 0, agent: "kimi" },
            { markModeAsTool: true, target: "current" },
          );
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
            builder,
          );
          continue;
        }

        if (msgType === "ToolResult") {
          const callId = String(payload.tool_call_id ?? "").trim();
          if (callId && ignoredToolCallIds.has(callId)) continue;
          const outputParts = normalizeWireToolOutputParts(payload.return_value, timestampMs);
          if (callId && this.backfillToolOutput(builder, callId, outputParts)) {
            continue;
          }
          if (outputParts.length > 0) {
            builder.appendMessage({
              id: `wire-${seq}`,
              role: "tool",
              timestampMs,
              parts: outputParts,
            });
          }
          continue;
        }

        // Skip StepBegin, StatusUpdate, ApprovalRequest, ApprovalResponse, TurnEnd
      } catch {
        // skip
      }
    }

    const stats = this.extractStats(meta.sourcePath);
    return this.buildSessionData(meta, builder, stats);
  }

  // --- Helpers ---

  private sourceFingerprint(meta: Pick<SessionSource, "metaFile" | "contextFile" | "wireFile">) {
    const fileMtime = (path: string | null) => {
      if (!path) return null;
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    };
    return JSON.stringify([
      fileMtime(meta.metaFile),
      fileMtime(meta.contextFile),
      fileMtime(meta.wireFile),
    ]);
  }

  private buildContextAssistantMessage(
    record: Record<string, unknown>,
    seq: number,
    ignoredToolCallIds: Set<string>,
    fallbackTs: number,
  ): TranscriptMessageInput | null {
    const parts: MessagePart[] = [];

    const content = record.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const ci = asRecord(item);
        if (!ci) continue;
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

    const toolCalls = asArray(record.tool_calls);
    if (toolCalls) {
      for (const tc of toolCalls) {
        const tcRecord = asRecord(tc);
        const function_ = asRecord(tcRecord?.function);

        if (!function_) continue;
        const toolName = String(function_.name ?? "").trim();
        const callId = String(tcRecord?.id ?? "").trim();

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
          state: {
            status: "running",
            input: normalizeToolArguments(function_.arguments),
            output: null,
          },
          time_created: fallbackTs,
        };
        parts.push(part);
      }
    }

    if (parts.length === 0) {
      return null;
    }

    const allTools = parts.every((p) => p.type === "tool");
    return {
      id: `context-${seq}`,
      role: "assistant",
      timestampMs: fallbackTs,
      parts,
      agent: "kimi",
      mode: allTools ? "tool" : undefined,
    };
  }

  private appendWireToolCallPart(
    argumentsPart: string,
    openCallId: string | null,
    buffer: Map<string, string>,
    builder: TranscriptBuilder,
  ): void {
    if (!openCallId) return;

    const existing = buffer.get(openCallId) ?? "";
    const combined = existing + argumentsPart;

    try {
      const parsed: unknown = JSON.parse(combined);
      if (
        builder.updateToolCall(openCallId, (part) => {
          part.state.input = parsed;
        })
      ) {
        buffer.delete(openCallId);
      }
    } catch {
      buffer.set(openCallId, combined);
    }
  }

  private backfillToolOutput(
    builder: TranscriptBuilder,
    callId: string,
    outputParts: MessagePart[],
  ): boolean {
    if (!outputParts.length || !callId) return false;

    return builder.resolveToolCall(callId, { output: [...outputParts] });
  }

  /** Applies a `_usage` record's running total; other records are ignored. */
  private applyUsageTotal(record: Record<string, unknown>, stats: SessionDetail["stats"]): void {
    if (record.role !== "_usage") return;
    const tokenCount = asNumber(record.token_count);
    if (tokenCount === undefined) {
      reportFieldMismatch("kimi", "usage.token_count");
      return;
    }
    stats.total_tokens = tokenCount;
  }

  private extractStats(sessionDir: string): SessionDetail["stats"] {
    let totalCost = 0;
    const stats: SessionDetail["stats"] = {
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      message_count: 0,
    };

    const wirePath = join(sessionDir, "wire.jsonl");
    if (!existsSync(wirePath)) return stats;

    // The `_usage` running total is read from context.jsonl when it exists.
    // Otherwise it lives in wire.jsonl — the same file this pass already walks,
    // so fold it in here rather than reading wire.jsonl a second time.
    const contextPath = join(sessionDir, "context.jsonl");
    const hasContext = existsSync(contextPath);

    try {
      for (const record of readJsonlFile(wirePath)) {
        const tokenUsage = asRecord(asRecord(record.message)?.usage);
        if (tokenUsage) {
          const inputTokens = extractTokenField(tokenUsage, "input_tokens");
          const outputTokens = extractTokenField(tokenUsage, "output_tokens");
          stats.total_input_tokens += inputTokens;
          stats.total_output_tokens += outputTokens;
          const cost = estimateTokenCost(this.defaultModel, {
            input: inputTokens,
            output: outputTokens,
          });
          if (cost !== null) totalCost += cost;
        }
        if (!hasContext) this.applyUsageTotal(record, stats);
      }
    } catch {
      // skip unreadable wire logs
    }

    if (hasContext) {
      try {
        for (const record of readJsonlFile(contextPath)) this.applyUsageTotal(record, stats);
      } catch {
        // skip unreadable context logs
      }
    }

    stats.total_cost = Number(totalCost.toFixed(8));
    if (stats.total_cost > 0) {
      stats.cost_source = "estimated";
    }

    return stats;
  }

  private buildSessionData(
    meta: SessionMeta,
    builder: TranscriptBuilder,
    stats: SessionDetail["stats"],
  ): SessionDetail {
    const transcript = builder.finish(stats);
    return {
      reference: { agentName: this.name, sessionId: meta.id },
      id: meta.id,
      title: meta.title,
      slug: `kimi/${meta.id}`,
      directory: meta.cwd,
      time_created: meta.createdAt,
      time_updated: meta.createdAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }
}
