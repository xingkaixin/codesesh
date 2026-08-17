import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import {
  FileSystemSessionSource,
  filteredSession,
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
  SessionSourceRef,
} from "./base.js";
import type {
  MessagePart,
  SessionDetail,
  SessionHead,
  SessionStats,
  ToolPart,
} from "../types/index.js";
import { resolveHomePath } from "../discovery/paths.js";
import { readJsonlFile } from "../utils/jsonl.js";
import { asArray, asNumber, asRecord, asString } from "../utils/narrow.js";
import { parseAgentTimestamp } from "../utils/timestamp.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { estimateTokenCost } from "../utils/cost.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";
import { normalizeToolArguments } from "./tool-arguments.js";

const KIMI_CODE_TOOL_TITLE_MAP: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  TodoList: "todo",
  AskUserQuestion: "ask",
  EnterPlanMode: "plan mode",
  ExitPlanMode: "plan approved",
  ReadFile: "read",
  Glob: "glob",
  StrReplaceFile: "edit",
  Grep: "grep",
  WriteFile: "write",
  Shell: "bash",
};

const KIMI_CODE_IGNORED_TOOLS = new Set(["SetTodoList"]);
const KIMI_CODE_PARSER_REVISION = "kimi-code-parser-v2";

export function resolveKimiCodeDataRoot(): string {
  return resolveHomePath("KIMI_CODE_HOME", ".kimi-code");
}

interface SessionSource {
  id: string;
  sourcePath: string;
  stateFile: string;
  wireFile: string;
  workDir: string;
  createdAt: number;
  activityAt: number;
  stateMtimeMs: number;
  stateSize: number;
  wireMtimeMs: number;
  wireSize: number;
  explicitTitle: string;
}

interface SessionMeta extends SessionCacheMeta {
  wireFile: string;
  workDir: string;
  createdAt: number;
  activityAt: number;
  title: string;
  sourceMtimeMs: number;
}

interface UsageTotals {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  modelUsage: Record<string, number>;
}

interface ParsedWire {
  builder: TranscriptBuilder;
  stats: SessionStats;
  firstUserTitle: string | null;
  modelUsage: Record<string, number>;
}

function mapToolTitle(toolName: string): string {
  return KIMI_CODE_TOOL_TITLE_MAP[toolName] ?? toolName;
}

function parseTimestamp(raw: unknown): number | null {
  return parseAgentTimestamp(raw, "kimi-code", { numericStrings: true });
}

function timestampFromRecord(record: Record<string, unknown>): number {
  return parseTimestamp(record.time) ?? 0;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const record = asRecord(content);
    return record ? String(record.text ?? "") : "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return record ? String(record.text ?? "") : "";
    })
    .join(" ");
}

function contentParts(content: unknown, timestampMs: number): MessagePart[] {
  const values = Array.isArray(content) ? content : [content];
  const parts: MessagePart[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      const text = cleanInternalText(value);
      if (text) parts.push({ type: "text", text, time_created: timestampMs });
      continue;
    }

    const record = asRecord(value);
    if (!record) continue;
    const type = asString(record.type) ?? "";
    if (type === "text") {
      const text = cleanInternalText(asString(record.text) ?? "");
      if (text) parts.push({ type: "text", text, time_created: timestampMs });
      continue;
    }
    if (type === "think") {
      const text = cleanInternalText(asString(record.think) ?? "");
      if (text) parts.push({ type: "reasoning", text, time_created: timestampMs });
      continue;
    }
    if (type === "plan") {
      const text = cleanInternalText(asString(record.text) ?? "");
      if (text) {
        parts.push({
          type: "plan",
          text,
          approval_status: record.approved === false ? "fail" : "success",
          time_created: timestampMs,
        });
      }
      continue;
    }
    if (type === "image") {
      const source = asRecord(record.source);
      const imageUrl = asRecord(record.imageUrl);
      const url =
        asString(record.url) ??
        asString(imageUrl?.url) ??
        (source?.kind === "url" ? asString(source.url) : undefined);
      const data =
        asString(record.data) ?? (source?.kind === "base64" ? asString(source.data) : undefined);
      const mimeType =
        asString(record.mime_type) ??
        asString(record.media_type) ??
        (source?.kind === "base64" ? asString(source.media_type) : undefined) ??
        "application/octet-stream";
      if (url) parts.push({ type: "image", url, mime_type: mimeType, time_created: timestampMs });
      else if (data) {
        parts.push({
          type: "image",
          data,
          mime_type: mimeType,
          time_created: timestampMs,
        });
      }
      continue;
    }
    if (type === "image_url") {
      const imageUrl = asRecord(record.imageUrl);
      const url = asString(imageUrl?.url) ?? asString(record.url);
      if (url) parts.push({ type: "image", url, time_created: timestampMs });
    }
  }

  return parts;
}

function toolOutputParts(output: unknown, timestampMs: number): MessagePart[] {
  if (typeof output === "string") {
    const text = cleanInternalText(output);
    return text ? [{ type: "text", text, time_created: timestampMs }] : [];
  }
  if (Array.isArray(output)) return contentParts(output, timestampMs);
  if (output == null) return [];

  const record = asRecord(output);
  if (record?.type === "text") return contentParts([record], timestampMs);

  const text = cleanInternalText(JSON.stringify(output, null, 2));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

function toolPart(toolName: string, callId: string, input: unknown, timestampMs: number): ToolPart {
  return {
    type: "tool",
    tool: toolName,
    callID: callId,
    title: mapToolTitle(toolName),
    state: {
      status: "running",
      ...(input === undefined ? {} : { input }),
      output: null,
    },
    time_created: timestampMs,
  };
}

function toolCallParts(
  message: Record<string, unknown>,
  timestampMs: number,
  ignoredToolCallIds: Set<string>,
): MessagePart[] {
  const calls = asArray(message.toolCalls) ?? [];
  const parts: MessagePart[] = [];

  for (const call of calls) {
    const callRecord = asRecord(call);
    const functionRecord = asRecord(callRecord?.function) ?? callRecord;
    const toolName = asString(functionRecord?.name)?.trim() ?? "";
    const callId = asString(callRecord?.id)?.trim() ?? "";
    if (!toolName || !callId) continue;
    if (KIMI_CODE_IGNORED_TOOLS.has(toolName)) {
      ignoredToolCallIds.add(callId);
      continue;
    }

    const rawArguments = functionRecord?.arguments ?? callRecord?.arguments;
    parts.push(toolPart(toolName, callId, normalizeToolArguments(rawArguments), timestampMs));
  }

  return parts;
}

function addToolResolution(
  builder: TranscriptBuilder,
  callId: string,
  output: unknown,
  timestampMs: number,
  isError = false,
  note?: string,
): boolean {
  const outputParts = toolOutputParts(output, timestampMs);
  return builder.resolveToolCall(callId, {
    output: outputParts,
    status: isError ? "error" : "completed",
    ...(note ? { metadata: { note: cleanInternalText(note) } } : {}),
  });
}

function usageNumber(usage: Record<string, unknown>, field: string): number {
  return asNumber(usage[field]) ?? 0;
}

function emptyStats(): SessionStats {
  return {
    message_count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
  };
}

function buildUsageTotals(): UsageTotals {
  return {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    modelUsage: {},
  };
}

function applyUsage(
  builder: TranscriptBuilder,
  record: Record<string, unknown>,
  activeModel: string | null,
  totals: UsageTotals,
): void {
  const usage = asRecord(record.usage);
  if (!usage) return;

  const cacheRead = usageNumber(usage, "inputCacheRead");
  const cacheCreate = usageNumber(usage, "inputCacheCreation");
  const inputOther = usageNumber(usage, "inputOther");
  const output = usageNumber(usage, "output");
  const input = inputOther + cacheRead + cacheCreate;
  const model = asString(record.model) ?? activeModel;
  const tokens = {
    input,
    output,
    cache_read: cacheRead,
    cache_create: cacheCreate,
  };
  const cost = estimateTokenCost(model, tokens);

  totals.totalInputTokens += input;
  totals.totalOutputTokens += output;
  totals.totalCacheReadTokens += cacheRead;
  totals.totalCacheCreateTokens += cacheCreate;
  if (model) totals.modelUsage[model] = (totals.modelUsage[model] ?? 0) + input + output;
  if (cost !== null) totals.totalCost += cost;

  builder.attachUsageToLatestAssistant(tokens, {
    model,
    cost: cost ?? undefined,
    costSource: cost === null ? undefined : "estimated",
  });
}

function readState(stateFile: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(stateFile, "utf-8"))) ?? null;
  } catch {
    return null;
  }
}

const AGENT_METADATA = getAgentCatalogEntry("kimi-code");

export class KimiCodeAgent extends FileSystemSessionSource<SessionMeta> {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  private basePath: string | null = null;
  private workDirBySessionPath = new Map<string, string>();

  private findBasePath(): string | null {
    const sessionsPath = join(resolveKimiCodeDataRoot(), "sessions");
    return existsSync(sessionsPath) ? sessionsPath : null;
  }

  getSessionWatchPlan() {
    const dataRoot = resolveKimiCodeDataRoot();
    return {
      status: "supported" as const,
      targets: [
        { root: dataRoot, path: join(dataRoot, "sessions") },
        { root: dataRoot, path: join(dataRoot, "session_index.jsonl") },
      ],
    };
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    return this.listSessionDirs().length > 0;
  }

  private loadSessionIndex(): void {
    this.workDirBySessionPath.clear();
    if (!this.basePath) return;

    const indexPath = join(dirname(this.basePath), "session_index.jsonl");
    if (!existsSync(indexPath)) return;
    for (const record of readJsonlFile(indexPath)) {
      const sessionPath = asString(record.sessionDir);
      const workDir = asString(record.workDir);
      if (!sessionPath || !workDir) continue;
      this.workDirBySessionPath.set(resolve(sessionPath), workDir);
    }
  }

  private listSessionDirs(): string[] {
    if (!this.basePath) return [];
    const dirs: string[] = [];

    for (const bucket of this.readSessionSourceDirectory(this.basePath)) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = join(this.basePath, bucket.name);
      for (const session of this.readSessionSourceDirectory(bucketPath)) {
        if (!session.isDirectory()) continue;
        const sessionPath = join(bucketPath, session.name);
        if (
          existsSync(join(sessionPath, "state.json")) &&
          existsSync(join(sessionPath, "agents", "main", "wire.jsonl"))
        ) {
          dirs.push(sessionPath);
        }
      }
    }

    return dirs;
  }

  private resolveSessionSourceResult(sessionDir: string): ParseSessionResult<SessionSource> {
    try {
      const stateFile = join(sessionDir, "state.json");
      const wireFile = join(sessionDir, "agents", "main", "wire.jsonl");
      if (!existsSync(stateFile) || !existsSync(wireFile)) return skippedSession("missing wire");

      const state = readState(stateFile);
      if (!state) return skippedSession("malformed state");

      const stateStat = statSync(stateFile);
      const wireStat = statSync(wireFile);
      const createdAt =
        parseTimestamp(state.createdAt) ?? parseTimestamp(state.created_at) ?? stateStat.mtimeMs;
      const activityAt = Math.max(
        parseTimestamp(state.updatedAt) ?? parseTimestamp(state.updated_at) ?? createdAt,
        wireStat.mtimeMs,
      );
      const custom = asRecord(state.custom);
      const workDir =
        asString(state.workDir) ??
        asString(custom?.cwd) ??
        this.workDirBySessionPath.get(resolve(sessionDir)) ??
        "";
      const explicitTitle = asString(state.title) ?? asString(state.customTitle) ?? "";

      return parsedSession({
        id: basename(sessionDir),
        sourcePath: sessionDir,
        stateFile,
        wireFile,
        workDir,
        createdAt,
        activityAt,
        stateMtimeMs: stateStat.mtimeMs,
        stateSize: stateStat.size,
        wireMtimeMs: wireStat.mtimeMs,
        wireSize: wireStat.size,
        explicitTitle,
      });
    } catch {
      return skippedSession("malformed session");
    }
  }

  private sourceFingerprint(source: SessionSource): string {
    return JSON.stringify([
      KIMI_CODE_PARSER_REVISION,
      source.stateMtimeMs,
      source.stateSize,
      source.wireMtimeMs,
      source.wireSize,
      source.createdAt,
      source.activityAt,
      source.workDir,
      source.explicitTitle,
    ]);
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    this.loadSessionIndex();
    const refs: SessionSourceRef[] = [];

    for (const sessionDir of this.listSessionDirs()) {
      const source = getParsedSession(this.resolveSessionSourceResult(sessionDir));
      if (!source || !matchesScanWindow(source.activityAt, options)) continue;
      refs.push({
        sessionId: source.id,
        sourcePath: source.sourcePath,
        fingerprint: this.sourceFingerprint(source),
      });
    }

    return refs;
  }

  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const result = super.checkForChanges(sinceTimestamp, cachedSessions);
    if (result.status === "failed") return result;
    const emptySessionIds = cachedSessions
      .filter((session) => !this.hasMessages(session))
      .map((session) => session.id);
    if (emptySessionIds.length === 0) return result;

    return {
      ...result,
      hasChanges: true,
      changedIds: [...new Set([...(result.changedIds ?? []), ...emptySessionIds])],
    };
  }

  filterCachedSessions(sessions: SessionHead[]): SessionHead[] {
    return this.removeEmptyCachedSessions(sessions);
  }

  incrementalScan(
    cachedSessions: SessionHead[],
    changedIds: string[],
    refs?: SessionSourceRef[],
    scanOptions?: AgentScanOptions,
  ): SessionHead[] {
    const visibleSessions = this.removeEmptyCachedSessions(cachedSessions);
    return super.incrementalScan(visibleSessions, changedIds, refs, scanOptions);
  }

  private hasMessages(session: SessionHead): boolean {
    return session.stats.message_count > 0;
  }

  private removeEmptyCachedSessions(sessions: SessionHead[]): SessionHead[] {
    return sessions.filter((session) => {
      if (this.hasMessages(session)) return true;
      this.sessionMetaMap.delete(session.id);
      return false;
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
    this.loadSessionIndex();
    const result = this.resolveSessionSourceResult(sourcePath);
    if (result.status !== "parsed") return result;
    const source = result.data;

    const parsed = this.parseWire(source);
    const transcript = parsed.builder.finish(parsed.stats);
    if (transcript.messages.length === 0) {
      this.sessionMetaMap.delete(source.id);
      return filteredSession("no visible messages");
    }

    const title = resolveSessionTitle(source.explicitTitle, parsed.firstUserTitle, null);
    const meta: SessionMeta = {
      id: source.id,
      sourcePath: source.sourcePath,
      wireFile: source.wireFile,
      workDir: source.workDir,
      createdAt: source.createdAt,
      activityAt: source.activityAt,
      title,
      sourceMtimeMs: source.activityAt,
      sourceFingerprint: this.sourceFingerprint(source),
    };
    this.sessionMetaMap.set(meta.id, meta);
    return parsedSession({
      id: meta.id,
      slug: this.sessionSlug(meta.id),
      title: meta.title,
      directory: meta.workDir,
      time_created: meta.createdAt,
      time_updated: meta.activityAt,
      stats: transcript.stats,
      ...(Object.keys(parsed.modelUsage).length > 0 ? { model_usage: parsed.modelUsage } : {}),
    });
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    const parsed = this.parseWire(meta);
    const transcript = parsed.builder.finish(parsed.stats);
    return {
      reference: { agentName: this.name, sessionId: meta.id },
      id: meta.id,
      title: meta.title,
      slug: this.sessionSlug(meta.id),
      directory: meta.workDir,
      time_created: meta.createdAt,
      time_updated: meta.activityAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }

  private parseWire(source: Pick<SessionSource, "wireFile">): ParsedWire {
    const builder = new TranscriptBuilder();
    const totals = buildUsageTotals();
    const ignoredToolCallIds = new Set<string>();
    let activeModel: string | null = null;
    let activeProvider: string | null = null;
    let firstUserTitle: string | null = null;
    let sequence = 0;

    for (const record of readJsonlFile(source.wireFile)) {
      sequence += 1;
      try {
        const timestampMs = timestampFromRecord(record);
        const recordType = asString(record.type) ?? "";

        if (recordType === "llm.request") {
          activeModel = asString(record.model) ?? activeModel;
          activeProvider = asString(record.provider) ?? activeProvider;
          continue;
        }
        if (recordType === "config.update") {
          activeModel = asString(record.modelAlias) ?? activeModel;
          continue;
        }
        if (recordType === "usage.record") {
          applyUsage(builder, record, activeModel, totals);
          continue;
        }
        if (recordType === "context.append_message") {
          const message = asRecord(record.message);
          if (!message) continue;
          const role = asString(message.role) ?? "";
          const messageTimestamp = timestampMs;

          if (role === "user") {
            const text = normalizeTitleText(contentText(message.content));
            if (!firstUserTitle && text) firstUserTitle = text;
          }

          if (role === "tool") {
            const callId = asString(message.toolCallId)?.trim() ?? "";
            const output = message.content;
            if (callId && ignoredToolCallIds.has(callId)) continue;
            if (callId && addToolResolution(builder, callId, output, messageTimestamp)) continue;
            const outputParts = toolOutputParts(output, messageTimestamp);
            if (outputParts.length > 0) {
              builder.appendMessage({
                id: `wire-${sequence}`,
                role: "tool",
                timestampMs: messageTimestamp,
                parts: outputParts,
              });
            }
            continue;
          }

          if (role !== "user" && role !== "assistant") continue;
          const parts = [
            ...contentParts(message.content, messageTimestamp),
            ...(role === "assistant"
              ? toolCallParts(message, messageTimestamp, ignoredToolCallIds)
              : []),
          ];
          if (parts.length === 0) continue;
          const allTools = parts.every((part) => part.type === "tool");
          const input: TranscriptMessageInput = {
            id: `wire-${sequence}`,
            role,
            timestampMs: messageTimestamp,
            parts,
            ...(role === "assistant"
              ? {
                  agent: this.name,
                  mode: allTools ? "tool" : undefined,
                  model: activeModel,
                  provider: activeProvider,
                }
              : {}),
          };
          builder.appendMessage(input);
          continue;
        }
        if (recordType === "context.append_loop_event") {
          const event = asRecord(record.event);
          if (!event) continue;
          const eventType = asString(event.type) ?? "";
          const metadata = {
            id: `wire-${sequence}`,
            timestampMs,
            agent: this.name,
            model: activeModel,
            provider: activeProvider,
          };

          if (eventType === "step.begin") {
            builder.beginTurn();
            continue;
          }
          if (eventType === "content.part") {
            const part = asRecord(event.part);
            if (!part) continue;
            const parts = contentParts([part], timestampMs);
            for (const contentPart of parts) {
              if (contentPart.type === "tool") continue;
              if (contentPart.type === "image" && builder.appendToCurrentAssistant(contentPart)) {
                continue;
              }
              builder.appendAssistantPart(contentPart, metadata, { grouping: "current" });
            }
            continue;
          }
          if (eventType === "tool.call") {
            const toolName = asString(event.name)?.trim() ?? "";
            const callId = asString(event.toolCallId)?.trim() ?? "";
            if (!toolName || !callId) continue;
            if (KIMI_CODE_IGNORED_TOOLS.has(toolName)) {
              ignoredToolCallIds.add(callId);
              continue;
            }
            builder.appendToolCall(toolPart(toolName, callId, event.args, timestampMs), metadata, {
              markModeAsTool: true,
              target: "current",
            });
            continue;
          }
          if (eventType === "tool.result") {
            const callId = asString(event.toolCallId)?.trim() ?? "";
            const result = asRecord(event.result);
            if (!callId || ignoredToolCallIds.has(callId)) continue;
            const output = result?.output;
            const isError = result?.isError === true;
            const note = asString(result?.note);
            if (addToolResolution(builder, callId, output, timestampMs, isError, note)) continue;
            const outputParts = toolOutputParts(output, timestampMs);
            if (outputParts.length > 0) {
              builder.appendMessage({
                id: `wire-${sequence}`,
                role: "tool",
                timestampMs,
                parts: outputParts,
              });
            }
          }
          continue;
        }
        if (recordType === "context.apply_compaction") {
          const summary = cleanInternalText(asString(record.summary) ?? "");
          if (summary) {
            builder.appendMessage({
              id: `wire-${sequence}`,
              role: "user",
              timestampMs,
              parts: [{ type: "text", text: summary, time_created: timestampMs }],
            });
          }
        }
      } catch {
        continue;
      }
    }

    const stats: SessionStats = {
      ...emptyStats(),
      total_input_tokens: totals.totalInputTokens,
      total_output_tokens: totals.totalOutputTokens,
      total_cost: Number(totals.totalCost.toFixed(8)),
      total_tokens: totals.totalInputTokens + totals.totalOutputTokens,
      ...(totals.totalCacheReadTokens > 0
        ? { total_cache_read_tokens: totals.totalCacheReadTokens }
        : {}),
      ...(totals.totalCacheCreateTokens > 0
        ? { total_cache_create_tokens: totals.totalCacheCreateTokens }
        : {}),
      ...(totals.totalCost > 0 ? { cost_source: "estimated" as const } : {}),
    };
    return { builder, stats, firstUserTitle, modelUsage: totals.modelUsage };
  }
}
