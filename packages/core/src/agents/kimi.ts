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
import type { SessionHead, SessionData, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { parseJsonlLines } from "../utils/jsonl.js";
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
        const state = asRecord(JSON.parse(readFileSync(statePath, "utf-8"))) ?? {};
        title = String(state.custom_title ?? "");
        wireMtime = readWireMtime(state);
        metaFile = statePath;
      } else if (existsSync(metaPath)) {
        const meta = asRecord(JSON.parse(readFileSync(metaPath, "utf-8"))) ?? {};
        title = String(meta.title ?? "");
        wireMtime = readWireMtime(meta);
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

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    const refs: SessionSourceRef[] = [];
    for (const dir of this.listSessionDirs()) {
      const meta = getParsedSession(this.parseSessionDirResult(dir));
      if (!meta || !matchesScanWindow(meta.createdAt, options)) continue;
      refs.push({
        sessionId: meta.id,
        sourcePath: meta.sourcePath,
        fingerprint: this.sourceFingerprint(meta),
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
    const builder = new TranscriptBuilder();
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

  private getSessionDataFromWire(meta: SessionMeta): SessionData {
    const wirePath = meta.wireFile ?? join(meta.sourcePath, "wire.jsonl");
    if (!existsSync(wirePath)) throw new Error("wire.jsonl is missing");

    const content = readFileSync(wirePath, "utf-8");
    const builder = new TranscriptBuilder();
    const ignoredToolCallIds = new Set<string>();
    const openToolArgumentBuffer = new Map<string, string>();

    let openToolCallId: string | null = null;
    let seq = 0;

    for (const record of parseJsonlLines(content)) {
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
            state: { arguments: normalizedArgs, output: null },
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

  private sourceFingerprint(meta: SessionMeta): string {
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
          state: { arguments: normalizeToolArguments(function_.arguments), output: null },
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
          const state = part.state ?? (part.state = {});
          state.arguments = parsed;
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
          const data = asRecord(JSON.parse(line));
          const tokenUsage = asRecord(asRecord(data?.message)?.usage);
          if (!tokenUsage) continue;
          const inputTokens = extractTokenField(tokenUsage, "input_tokens");
          const outputTokens = extractTokenField(tokenUsage, "output_tokens");
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
          const data = asRecord(JSON.parse(line));
          if (data?.role !== "_usage") continue;
          const tokenCount = asNumber(data.token_count);
          if (tokenCount === undefined) {
            reportFieldMismatch("kimi", "usage.token_count");
            continue;
          }
          stats.total_tokens = tokenCount;
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
    builder: TranscriptBuilder,
    stats: SessionData["stats"],
  ): SessionData {
    const transcript = builder.finish(stats);
    return {
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
