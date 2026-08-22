import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { SingleFileSessionSource, filteredSession, parsedSession, skippedSession } from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type { Message, SessionHead, SessionDetail, MessagePart } from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { parseJsonlLines, readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { cleanInternalText, isInternalEventType } from "../utils/session-normalization.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { asRecord, asString } from "../utils/narrow.js";
import { TranscriptBuilder } from "./transcript-builder.js";
import {
  CodexRecordConverter,
  extractAssistantOutputText,
  extractCodexPayload,
  isDeveloperLikeUserMessage,
  narrowRecordField,
  parseCodexTimestampMs,
} from "./codex-record-converter.js";
import { CodexTokenUsageAccumulator } from "./codex-token-usage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAD_INDEX_VERSION = "codex-head-v2";
const PARSER_VERSION = "codex-parser-v8";

export function resolveCodexDataRoot(): string {
  return resolveHomePath("CODEX_HOME", ".codex");
}

// ---------------------------------------------------------------------------
// Session ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract session UUID from Codex filename.
 * "rollout-2026-02-03T10-04-47-019c213e-c251-73a3-af66-0ec9d7cb9e29.jsonl"
 * → last 5 dash-delimited parts joined with "-"
 */
function extractSessionId(filename: string): string {
  const stem = basename(filename, ".jsonl");
  const parts = stem.split("-");
  if (parts.length >= 5) {
    return parts.slice(-5).join("-");
  }
  return stem;
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

function extractModelName(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

interface ThreadMeta {
  threadSource: string;
  parentThreadId: string | null;
  agentNickname: string | null;
}

function extractThreadMeta(firstRecord: Record<string, unknown>): ThreadMeta | null {
  if (firstRecord["type"] !== "session_meta") return null;
  const payload = extractCodexPayload(firstRecord);
  const threadSource = asString(payload["thread_source"]) ?? "";
  const parentThreadId = asString(payload["parent_thread_id"]) ?? null;
  const agentNickname = asString(payload["agent_nickname"]) ?? null;
  return { threadSource, parentThreadId, agentNickname };
}

// Leading-line reads want a few KB, not the default 1 MiB streaming buffer;
// readJsonlFileLines keeps accumulating chunks if a single line runs longer.
const LEADING_READ_CHUNK_BYTES = 64 * 1024;

function readLeadingJsonlLines(filePath: string, limit: number): string[] {
  const lines: string[] = [];
  for (const line of readJsonlFileLines(filePath, LEADING_READ_CHUNK_BYTES)) {
    if (!line.trim()) continue;
    lines.push(line);
    if (lines.length === limit) break;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Session meta
// ---------------------------------------------------------------------------

import type {
  AgentScanOptions,
  FileSessionMeta,
  SessionCacheMeta,
  SessionSourceFile,
  SessionSourceRef,
} from "./base.js";

/** 一次全量前缀扫构建的 subagent 关系索引；miss 即代表"无子会话"。 */
interface SubagentIndex {
  childFilesByParent: Map<string, string[]>;
  subagentFiles: Set<string>;
}

interface SessionMeta extends FileSessionMeta {
  indexPath: string | null;
  indexMtimeMs: number | null;
  headIndexVersion: string;
  parserVersion: string;
  parentThreadId: string | null;
}

interface ChildFinalMessageCacheEntry {
  sourceFingerprint: string;
  parserVersion: string;
  message: Message | null;
}

class ChildMessageVisibilityIndex {
  private readonly visibleSubagentIds = new Set<string>();
  private readonly visibleNicknameTexts = new Map<string, Set<string>>();

  constructor(messages: Message[]) {
    for (const message of messages) this.add(message);
  }

  hasEquivalent(message: Message): boolean {
    if (message.subagent_id !== undefined && this.visibleSubagentIds.has(message.subagent_id)) {
      return true;
    }

    const nickname = message.nickname;
    const text = message.parts.find((part) => part.type === "text")?.text;
    return (
      nickname !== undefined &&
      text !== undefined &&
      this.visibleNicknameTexts.get(nickname)?.has(text) === true
    );
  }

  add(message: Message): void {
    if (message.subagent_id !== undefined) {
      this.visibleSubagentIds.add(message.subagent_id);
      return;
    }
    if (message.nickname === undefined) return;

    let texts = this.visibleNicknameTexts.get(message.nickname);
    if (!texts) {
      texts = new Set();
      this.visibleNicknameTexts.set(message.nickname, texts);
    }
    for (const part of message.parts) {
      if (part.type === "text") texts.add(part.text);
    }
  }
}

function compareSourceActivityDesc(left: SessionSourceFile, right: SessionSourceFile): number {
  const leftTimestamp = sourceTimestamp(left.file, left.stat.mtimeMs);
  const rightTimestamp = sourceTimestamp(right.file, right.stat.mtimeMs);
  return rightTimestamp - leftTimestamp || left.file.localeCompare(right.file);
}

function sourceTimestamp(filePath: string, fallback: number): number {
  // Sort before parsing heads; the rollout filename is the only cheap activity hint.
  const match = basename(filePath).match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/);
  if (!match) return fallback;
  const timestamp = match[1]!.replace(/-(\d{2})-(\d{2})$/, ":$1:$2");
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// CodexAgent
// ---------------------------------------------------------------------------

const CODEX_RECORD_CONVERTER = new CodexRecordConverter();

const AGENT_METADATA = getAgentCatalogEntry("codex");

export class CodexAgent extends SingleFileSessionSource<SessionMeta> {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  private basePath: string | null = this.configuredSourceRoot;
  private sessionIndexCache = new Map<string, string>();
  private sessionIndexMtime: number | null | undefined;
  private sessionIndexPath: string | undefined;
  private subagentIndex: SubagentIndex | null = null;
  // Thread meta lives in a rollout's immutable first line; fingerprinting by
  // (mtime, size) lets index rebuilds stat files instead of re-reading them.
  private readonly threadMetaByPath = new Map<
    string,
    { fingerprint: string; meta: ThreadMeta | null }
  >();
  private subagentStatsByParent = new Map<string, SessionHead["stats"][]>();
  private childFinalMessagesByParent = new Map<string, Map<string, ChildFinalMessageCacheEntry>>();

  // ---- BaseAgent implementation ----

  private findBasePath(): string | null {
    return this.configuredSourceRoot ?? firstExisting(join(resolveCodexDataRoot(), "sessions"));
  }

  getSessionWatchPlan() {
    if (this.configuredSourceRoot) {
      const root = dirname(this.configuredSourceRoot);
      return {
        status: "supported" as const,
        targets: [
          { root, path: this.configuredSourceRoot },
          { root, path: join(root, "session_index.jsonl") },
        ],
      };
    }
    const dataRoot = resolveCodexDataRoot();
    return {
      status: "supported" as const,
      targets: [
        { path: join(dataRoot, "sessions") },
        { path: join(dataRoot, "session_index.jsonl") },
      ],
    };
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    return this.listRolloutFiles().length > 0;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    this.loadSessionIndex();
    return this.listScanSources(options).map(({ file, stat }) => ({
      sessionId: extractSessionId(file),
      sourcePath: file,
      fingerprint: this.sourceFingerprint(file, stat),
    }));
  }

  restoreSessionCacheMeta(meta: Readonly<Record<string, SessionCacheMeta>>): void {
    super.restoreSessionCacheMeta(meta);
    this.subagentIndex = null;
    this.subagentStatsByParent.clear();
    this.childFinalMessagesByParent.clear();
  }

  /**
   * A changed subagent file leaves its parent's aggregated token stats stale,
   * so the parent must re-parse alongside the child.
   */
  expandChangedSessionIds(changedIds: string[], refs?: SessionSourceRef[]): string[] {
    if (changedIds.length === 0) return changedIds;
    const pathById = new Map((refs ?? []).map((ref) => [ref.sessionId, ref.sourcePath]));
    const expanded = new Set(changedIds);
    for (const id of changedIds) {
      const sourcePath = pathById.get(id) ?? this.sessionMetaMap.get(id)?.sourcePath;
      const threadMeta = sourcePath ? this.readThreadMeta(sourcePath) : null;
      // A removed file cannot be read back; cached meta still knows its parent.
      const parentId = threadMeta
        ? threadMeta.threadSource === "subagent"
          ? threadMeta.parentThreadId
          : null
        : (this.sessionMetaMap.get(id)?.parentThreadId ?? null);
      if (!parentId) continue;
      expanded.add(parentId);
      this.subagentIndex = null;
      this.subagentStatsByParent.delete(parentId);
      this.childFinalMessagesByParent.delete(parentId);
    }
    return [...expanded];
  }

  private readThreadMeta(filePath: string): ThreadMeta | null {
    try {
      const { mtimeMs, size } = statSync(filePath);
      const fingerprint = `${mtimeMs}:${size}`;
      const cached = this.threadMetaByPath.get(filePath);
      if (cached && cached.fingerprint === fingerprint) return cached.meta;
      const firstLine = readLeadingJsonlLines(filePath, 1)[0];
      const meta = firstLine ? extractThreadMeta(JSON.parse(firstLine)) : null;
      this.threadMetaByPath.set(filePath, { fingerprint, meta });
      return meta;
    } catch (error) {
      getCoreDiagnostics()?.warn("codex.thread_meta_read_failed", {
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private parseTokenStats(filePath: string): SessionHead["stats"] {
    const usage = new CodexTokenUsageAccumulator();
    let activeModel: string | null = null;

    for (const line of readJsonlFileLines(filePath)) {
      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        const payload = extractCodexPayload(data);

        if (recordType === "session_meta" || recordType === "turn_context") {
          const nextModel = extractModelName(payload["model"]);
          if (nextModel) activeModel = nextModel;
          continue;
        }

        if (recordType === "event_msg" && String(payload["type"] ?? "") === "token_count") {
          usage.consume(payload, activeModel);
        }
      } catch {
        // skip malformed records
      }
    }

    return usage.stats();
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);
    this.basePath ??= this.findBasePath();

    const transcript = new TranscriptBuilder();
    const usage = new CodexTokenUsageAccumulator();

    let pendingPlan: MessagePart | null = null;
    let activeModel: string | null = null;

    for (const record of readJsonlFile(meta.sourcePath)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType === "session_meta" || recordType === "turn_context") {
          const payload = extractCodexPayload(record);
          activeModel = extractModelName(payload["model"]) ?? activeModel;
        }

        pendingPlan = CODEX_RECORD_CONVERTER.convertRecord(
          record,
          transcript,
          pendingPlan,
          activeModel,
        );

        // Process Codex token_count events
        if (recordType === "event_msg") {
          const payload = extractCodexPayload(record);
          if (String(payload["type"] ?? "") === "token_count") {
            const delta = usage.consume(payload, activeModel);
            if (delta) {
              transcript.attachUsageToLatestAssistant(delta.tokens, {
                model: delta.model,
                cost: delta.cost ?? undefined,
                costSource: delta.cost === null ? undefined : "estimated",
              });
            }
          }
        }
      } catch {
        // skip malformed records
      }
    }

    if (pendingPlan) transcript.appendToCurrentAssistant(pendingPlan);
    const result = transcript.finish(usage.stats());

    this.applyChildStats(result.stats, meta.id);

    const childMessages = this.collectChildMessages(meta.id);
    this.mergeChildMessages(result.messages, childMessages);
    result.stats.message_count = result.messages.length;

    return {
      ...this.sessionIdentity(meta.id),
      title: meta.title,
      directory: meta.directory,
      parent_reference:
        meta.parentThreadId == null
          ? undefined
          : { agentName: this.name, sessionId: meta.parentThreadId },
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: result.stats,
      messages: result.messages,
    };
  }

  /**
   * Builds the complete parent→children map in one prefix sweep. A cache miss
   * afterwards means "no children", so per-session directory rescans (the old
   * O(N²) finalization hotspot) never happen.
   */
  private ensureSubagentIndex(): SubagentIndex {
    if (this.subagentIndex) return this.subagentIndex;
    this.basePath ??= this.findBasePath();
    const index: SubagentIndex = { childFilesByParent: new Map(), subagentFiles: new Set() };
    const paths = this.listRolloutFilePaths();
    for (const file of paths) {
      const threadMeta = this.readThreadMeta(file);
      if (threadMeta?.threadSource !== "subagent") continue;
      index.subagentFiles.add(file);
      if (!threadMeta.parentThreadId) continue;
      const files = index.childFilesByParent.get(threadMeta.parentThreadId);
      if (files) files.push(file);
      else index.childFilesByParent.set(threadMeta.parentThreadId, [file]);
    }
    if (this.threadMetaByPath.size > paths.length) {
      const active = new Set(paths);
      for (const path of this.threadMetaByPath.keys()) {
        if (!active.has(path)) this.threadMetaByPath.delete(path);
      }
    }
    this.subagentIndex = index;
    return index;
  }

  private applyChildStats(target: SessionHead["stats"], sessionId: string): void {
    for (const stats of this.collectChildStats(sessionId)) {
      target.total_input_tokens += stats.total_input_tokens ?? 0;
      target.total_output_tokens += stats.total_output_tokens ?? 0;
      target.total_cost += stats.total_cost ?? 0;
      if (stats.total_cache_read_tokens) {
        target.total_cache_read_tokens =
          (target.total_cache_read_tokens ?? 0) + stats.total_cache_read_tokens;
      }
    }
  }

  private collectChildStats(parentSessionId: string): SessionHead["stats"][] {
    const files = this.collectChildFiles(parentSessionId);
    if (files.length === 0) return [];
    const cached = this.subagentStatsByParent.get(parentSessionId);
    if (cached) return cached;

    const stats = files.map((file) => this.parseTokenStats(file));
    this.subagentStatsByParent.set(parentSessionId, stats);
    return stats;
  }

  private collectChildFiles(parentSessionId: string): string[] {
    return this.ensureSubagentIndex().childFilesByParent.get(parentSessionId) ?? [];
  }

  private mergeChildMessages(visibleMessages: Message[], childMessages: Message[]): void {
    const visible = new ChildMessageVisibilityIndex(visibleMessages);
    for (const message of childMessages) {
      if (visible.hasEquivalent(message)) continue;
      visibleMessages.push(message);
      visible.add(message);
    }
  }

  private collectChildMessages(parentSessionId: string): Message[] {
    const childFiles = this.collectChildFiles(parentSessionId);
    this.reconcileChildFinalMessageCache(parentSessionId, childFiles);
    return childFiles
      .flatMap((file) => {
        const message = this.getChildFinalMessage(parentSessionId, file);
        return message ? [message] : [];
      })
      .sort((left, right) => left.time_created - right.time_created);
  }

  private getChildFinalMessage(parentSessionId: string, filePath: string): Message | null {
    const sourceFingerprint = this.childFinalMessageFingerprint(filePath);
    let cache = this.childFinalMessagesByParent.get(parentSessionId);
    if (!cache) {
      cache = new Map();
      this.childFinalMessagesByParent.set(parentSessionId, cache);
    }

    const cached = cache.get(filePath);
    if (
      cached?.sourceFingerprint === sourceFingerprint &&
      cached.parserVersion === PARSER_VERSION
    ) {
      return cached.message;
    }

    const message = this.readChildFinalMessage(filePath);
    cache.set(filePath, { sourceFingerprint, parserVersion: PARSER_VERSION, message });
    return message;
  }

  private reconcileChildFinalMessageCache(parentSessionId: string, childFiles: string[]): void {
    const cache = this.childFinalMessagesByParent.get(parentSessionId);
    if (!cache) return;

    const activeFiles = new Set(childFiles);
    for (const filePath of cache.keys()) {
      if (!activeFiles.has(filePath)) cache.delete(filePath);
    }
    if (cache.size === 0) this.childFinalMessagesByParent.delete(parentSessionId);
  }

  private childFinalMessageFingerprint(filePath: string): string {
    const { mtimeMs, size } = statSync(filePath);
    return JSON.stringify([mtimeMs, size]);
  }

  private readChildFinalMessage(filePath: string): Message | null {
    const sessionId = extractSessionId(filePath);
    const threadMeta = this.readThreadMeta(filePath);
    type ChildOutput = { id: string; text: string; timestampMs: number; isFinal: boolean };
    let latestOutput: ChildOutput | null = null;
    let finalOutput: ChildOutput | null = null;
    let fallbackMtimeMs: number | null = null;

    for (const record of readJsonlFile(filePath)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType !== "response_item") continue;
        const payload = extractCodexPayload(record);
        if (String(payload["type"] ?? "") !== "message") continue;
        if (String(payload["role"] ?? "") !== "assistant") continue;

        const text = cleanInternalText(extractAssistantOutputText(payload));
        if (!text) continue;

        const candidate: ChildOutput = {
          id: asString(payload["id"]) ?? `codex-subagent-${sessionId}`,
          text,
          timestampMs:
            parseCodexTimestampMs(record) ||
            parseCodexTimestampMs(payload) ||
            (fallbackMtimeMs ??= statSync(filePath).mtimeMs),
          isFinal:
            String(record["phase"] ?? "") === "final_answer" ||
            String(payload["phase"] ?? "") === "final_answer",
        };
        latestOutput = candidate;
        if (candidate.isFinal) finalOutput = candidate;
      } catch {
        // skip malformed records
      }
    }

    const selected = finalOutput ?? latestOutput;
    if (!selected) return null;

    return {
      id: selected.id,
      role: "assistant",
      agent: "codex",
      time_created: selected.timestampMs,
      mode: null,
      model: null,
      provider: null,
      cost: 0,
      subagent_id: sessionId,
      nickname: threadMeta?.agentNickname ?? undefined,
      parts: [{ type: "text", text: selected.text, time_created: selected.timestampMs }],
    };
  }

  // ---- File listing ----

  private listRolloutFiles(options?: AgentScanOptions): SessionSourceFile[] {
    if (!this.basePath) return [];
    return this.walkFiles(
      this.basePath,
      (entry) => entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-"),
      { scanWindow: options },
    );
  }

  /** Path-only listing for the subagent index: no per-file stat needed. */
  private listRolloutFilePaths(): string[] {
    if (!this.basePath) return [];
    const paths: string[] = [];
    const walk = (directory: string): void => {
      const entries = this.readSessionSourceDirectory(directory);
      for (const entry of entries) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) walk(filePath);
        else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          paths.push(filePath);
        }
      }
    };
    walk(this.basePath);
    return paths;
  }

  private listScanSources(options?: AgentScanOptions): SessionSourceFile[] {
    const windowed = this.listRolloutFiles(options).sort(compareSourceActivityDesc);
    if (options?.from == null && options?.to == null) return windowed;

    const { childFilesByParent, subagentFiles } = this.ensureSubagentIndex();
    const rootFiles = windowed.filter((source) => !subagentFiles.has(source.file));
    const rootIds = new Set(rootFiles.map(({ file }) => extractSessionId(file)));
    if (rootIds.size === 0) return rootFiles;

    const selected = new Map(rootFiles.map((source) => [source.file, source]));
    const pending = [...rootIds];
    const seenParents = new Set<string>();
    while (pending.length > 0) {
      const parentId = pending.pop()!;
      if (seenParents.has(parentId)) continue;
      seenParents.add(parentId);
      for (const file of childFilesByParent.get(parentId) ?? []) {
        if (selected.has(file)) continue;
        try {
          selected.set(file, this.sessionSourceFile(file));
        } catch {
          continue;
        }
        pending.push(extractSessionId(file));
      }
    }
    return [...selected.values()].sort(compareSourceActivityDesc);
  }

  protected createFileSessionMeta(head: SessionHead, source: SessionSourceFile): SessionMeta {
    const indexPath = this.getSessionIndexPath();
    const indexMtime = this.sessionIndexMtime ?? null;
    return this.buildFileSessionMeta({
      head,
      source,
      fingerprint: this.sourceFingerprint(source.file, source.stat),
      extras: {
        indexPath: indexMtime === null ? null : indexPath,
        indexMtimeMs: indexMtime,
        headIndexVersion: HEAD_INDEX_VERSION,
        parserVersion: PARSER_VERSION,
        parentThreadId: head.parent_reference?.sessionId ?? null,
      },
    });
  }

  /** Fingerprint depends on an already-fetched stat to avoid re-statting the same file. */
  private sourceFingerprint(file: string, stat: { mtimeMs: number; size: number }): string {
    const sessionId = extractSessionId(file);
    return JSON.stringify([
      HEAD_INDEX_VERSION,
      PARSER_VERSION,
      stat.mtimeMs,
      stat.size,
      this.getTitleForSession(sessionId),
    ]);
  }

  private getSessionIndexPath(): string {
    this.sessionIndexPath ??= join(resolveCodexDataRoot(), "session_index.jsonl");
    return this.sessionIndexPath;
  }

  // ---- Session index ----

  private loadSessionIndex(): void {
    const indexPath = this.getSessionIndexPath();
    const mtime = this.readFileMtimeMs(indexPath);

    // Invalidate when the index file mtime advances so long-running processes
    // pick up title changes without relying on callers to evict manually.
    if (this.sessionIndexMtime !== undefined && this.sessionIndexMtime === mtime) return;

    if (mtime === null) {
      this.sessionIndexCache.clear();
      this.sessionIndexMtime = null;
      return;
    }

    try {
      const content = readFileSync(indexPath, "utf-8");
      const cache = new Map<string, string>();
      for (const record of parseJsonlLines(content)) {
        const sid = String(record["id"] ?? "").trim();
        const threadName = String(record["thread_name"] ?? "").trim();
        if (sid && threadName) {
          cache.set(sid, threadName);
        }
      }
      this.sessionIndexCache = cache;
      this.sessionIndexMtime = mtime;
    } catch (error) {
      // Titles silently falling back to filenames is a confusing failure
      // mode; keep the degradation but make it visible.
      getCoreDiagnostics()?.warn("codex.session_index_read_failed", {
        path: indexPath,
        message: error instanceof Error ? error.message : String(error),
      });
      this.sessionIndexCache.clear();
      this.sessionIndexMtime = undefined;
    }
  }

  private getTitleForSession(sessionId: string): string | null {
    return this.sessionIndexCache.get(sessionId) ?? null;
  }

  // ---- Session head parsing ----

  protected override parseFileSessionHeadResult(
    filePath: string,
    options?: AgentScanOptions,
  ): ParseSessionResult<SessionHead> {
    this.loadSessionIndex();
    if (options?.fast) {
      return this.parseFastSessionHeadResult(filePath);
    }

    const sessionId = extractSessionId(filePath);

    let firstPayload: Record<string, unknown> = {};
    let parentThreadId: string | null = null;
    let createdAt = 0;
    let lineCount = 0;
    let messageTitle: string | null = null;

    // Single streaming pass: read the first record, extract the title
    // candidate, count messages, extract models, and pre-accumulate tokens.
    let updatedAt = 0;
    let messageCount = 0;
    let activeModel: string | null = null;
    const usage = new CodexTokenUsageAccumulator();

    const COUNTED_TYPES = new Set(["message", "function_call", "function_call_output"]);

    let hasNonInternalRecord = false;

    for (const line of readJsonlFileLines(filePath)) {
      lineCount += 1;
      if (lineCount === 1) {
        let firstRecord: Record<string, unknown>;
        try {
          firstRecord = JSON.parse(line);
        } catch {
          return skippedSession("malformed first record");
        }
        firstPayload = extractCodexPayload(firstRecord);
        const threadMeta = extractThreadMeta(firstRecord);
        parentThreadId = threadMeta?.threadSource === "subagent" ? threadMeta.parentThreadId : null;
        createdAt =
          parseCodexTimestampMs(firstRecord) ||
          parseCodexTimestampMs(firstPayload) ||
          statSync(filePath).mtimeMs;
        updatedAt = createdAt;
      }

      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        const payload = extractCodexPayload(data);
        const payloadType = String(payload["type"] ?? "");
        if (isInternalEventType(recordType) || isInternalEventType(payloadType)) continue;
        hasNonInternalRecord = true;
        const recordTs = parseCodexTimestampMs(data) || parseCodexTimestampMs(payload);
        if (recordTs > updatedAt) updatedAt = recordTs;

        // Title fallback mirrors the removed extractTitleFromLines(): first
        // visible user message within the first 20 lines.
        if (messageTitle === null && lineCount <= 20) {
          const candidate = this.extractCodexRecordTitle(data);
          if (candidate) messageTitle = candidate;
        }

        if (recordType === "session_meta" || recordType === "turn_context") {
          const nextModel = extractModelName(payload["model"]);
          if (nextModel) {
            activeModel = nextModel;
          }
          continue;
        }

        if (recordType === "response_item") {
          const p = payload;
          const pType = String(p["type"] ?? "");
          if (COUNTED_TYPES.has(pType)) {
            messageCount++;
          }
          // Extract model from response_item
          const info = narrowRecordField(p["info"], "response_item.info");
          const m = info?.["model"] ?? p["model"];
          if (typeof m === "string" && m.trim()) {
            activeModel = m.trim();
          }
        }

        if (recordType === "event_msg") {
          if (String(payload["type"] ?? "") === "token_count") {
            usage.consume(payload, activeModel);
          }
        }
      } catch {
        // skip
      }
    }

    if (lineCount === 0) return skippedSession("empty file");
    if (!hasNonInternalRecord) return filteredSession("internal events only");

    const indexTitle = this.getTitleForSession(sessionId);
    const directory = firstPayload["cwd"] ? String(firstPayload["cwd"]) : "";
    const title = resolveSessionTitle(indexTitle, messageTitle, basenameTitle(directory || null));

    return parsedSession({
      ...this.sessionIdentity(sessionId),
      title,
      directory,
      parent_reference:
        parentThreadId == null ? undefined : { agentName: this.name, sessionId: parentThreadId },
      time_created: createdAt,
      time_updated: updatedAt,
      stats: usage.stats(messageCount),
      model_usage: usage.modelUsage(),
    });
  }

  private parseFastSessionHeadResult(filePath: string): ParseSessionResult<SessionHead> {
    const lines = readLeadingJsonlLines(filePath, 20);
    if (lines.length === 0) return skippedSession("empty file");

    const sessionId = extractSessionId(filePath);

    let firstRecord: Record<string, unknown>;
    try {
      firstRecord = JSON.parse(lines[0]!);
    } catch (error) {
      getCoreDiagnostics()?.warn("codex.fast_head_first_record_failed", {
        filePath,
        firstLineLength: lines[0]?.length ?? 0,
        message: error instanceof Error ? error.message : String(error),
      });
      return skippedSession("malformed first record");
    }

    const threadMeta = extractThreadMeta(firstRecord);
    const parentThreadId =
      threadMeta?.threadSource === "subagent" ? threadMeta.parentThreadId : null;

    const payload = extractCodexPayload(firstRecord);
    const stat = statSync(filePath);
    const createdAt =
      parseCodexTimestampMs(firstRecord) || parseCodexTimestampMs(payload) || stat.mtimeMs;
    const indexTitle = this.getTitleForSession(sessionId);
    const messageTitle = this.extractTitleFromLines(lines);
    const directory = payload["cwd"] ? String(payload["cwd"]) : "";
    const directoryTitle = basenameTitle(directory || null);
    const title = resolveSessionTitle(indexTitle, messageTitle, directoryTitle);

    return parsedSession({
      ...this.sessionIdentity(sessionId),
      title,
      directory,
      parent_reference:
        parentThreadId == null ? undefined : { agentName: this.name, sessionId: parentThreadId },
      time_created: createdAt,
      time_updated: stat.mtimeMs,
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });
  }

  /** Fast path only: parses each of the first 20 lines to find a title (no full stats pass available). */
  private extractTitleFromLines(lines: string[]): string | null {
    for (const line of lines.slice(0, 20)) {
      try {
        const title = this.extractCodexRecordTitle(JSON.parse(line));
        if (title) return title;
      } catch {
        // skip
      }
    }
    return null;
  }

  /**
   * Title candidate from a single already-parsed record, if it's a visible
   * user message. Shared by the main streaming pass (which parses every line
   * once) and the fast path's extractTitleFromLines().
   */
  private extractCodexRecordTitle(data: Record<string, unknown>): string | null {
    const recordType = String(data["type"] ?? "");
    if (recordType !== "response_item" || isInternalEventType(recordType)) return null;

    const payload = extractCodexPayload(data);
    const pType = String(payload["type"] ?? "");
    if (pType !== "message" || isInternalEventType(pType)) return null;
    if (String(payload["role"] ?? "") !== "user") return null;

    const content = payload["content"];
    let text: string | null = null;
    if (Array.isArray(content)) {
      text = content
        .map((item) => {
          const record = asRecord(item);
          return record ? String(record["text"] ?? "") : "";
        })
        .join(" ");
    } else if (typeof content === "string") {
      text = content;
    }
    if (!text || isDeveloperLikeUserMessage(text)) return null;
    return normalizeTitleText(text) || null;
  }
}
