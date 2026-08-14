import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import {
  SingleFileSessionSource,
  filteredSession,
  getParsedSession,
  parsedSession,
  skippedSession,
} from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type { Message, SessionHead, SessionDetail, MessagePart } from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { parseJsonlLines, readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { cleanInternalText, isInternalEventType } from "../utils/session-normalization.js";
import { estimateTokenCost } from "../utils/cost.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { parseAgentTimestampMs } from "../utils/timestamp.js";
import { asRecord, asString, narrowField } from "../utils/narrow.js";
import { TranscriptBuilder } from "./transcript-builder.js";
import { normalizeToolArguments } from "./tool-arguments.js";
import {
  type ExecInnerCall,
  decodeExecCalls,
  getExecPatchText,
  pickExecOutputTarget,
  splitExecToolName,
  stripExecOutputEnvelope,
} from "./codex-exec-decode.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;
const PLAN_APPROVAL_PREFIX = "PLEASE IMPLEMENT THIS PLAN";
const SUBAGENT_NOTIFICATION_PATTERN =
  /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/;
const HEAD_INDEX_VERSION = "codex-head-v1";
const PARSER_VERSION = "codex-parser-v8";

export function resolveCodexDataRoot(): string {
  return resolveHomePath("CODEX_HOME", ".codex");
}

const DEVELOPER_LIKE_USER_MARKERS = [
  "agents.md instructions for",
  "<instructions>",
  "<environment_context>",
  "<permissions instructions>",
  "<collaboration_mode>",
];

function isDeveloperLikeUserMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return DEVELOPER_LIKE_USER_MARKERS.some((m) => lower.includes(m));
}

const CODEX_TOOL_TITLE_MAP: Record<string, string> = {
  exec_command: "bash",
  apply_patch: "patch",
  patch: "patch",
  spawn_agent: "subagent",
  subagent: "subagent",
};

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

function parseTimestampMs(data: Record<string, unknown>): number {
  return parseAgentTimestampMs(String(data["timestamp"] ?? ""), "codex");
}

function extractModelName(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function extractCachedInputTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return Number(usage["cached_input_tokens"] ?? usage["cache_read_input_tokens"] ?? 0);
}

function narrowRecordField(value: unknown, field: string): Record<string, unknown> | undefined {
  return narrowField("codex", field, value, asRecord);
}

function extractPayload(data: Record<string, unknown>): Record<string, unknown> {
  return narrowRecordField(data["payload"], "payload") ?? {};
}

interface ThreadMeta {
  threadSource: string;
  parentThreadId: string | null;
  agentNickname: string | null;
}

function extractThreadMeta(firstRecord: Record<string, unknown>): ThreadMeta | null {
  if (firstRecord["type"] !== "session_meta") return null;
  const payload = extractPayload(firstRecord);
  const threadSource = asString(payload["thread_source"]) ?? "";
  const parentThreadId = asString(payload["parent_thread_id"]) ?? null;
  const agentNickname = asString(payload["agent_nickname"]) ?? null;
  return { threadSource, parentThreadId, agentNickname };
}

function readLeadingJsonlLines(filePath: string, limit: number): string[] {
  const lines: string[] = [];
  for (const line of readJsonlFileLines(filePath)) {
    if (!line.trim()) continue;
    lines.push(line);
    if (lines.length === limit) break;
  }
  return lines;
}

function extractTokenUsage(payload: Record<string, unknown>): {
  totalUsage: Record<string, unknown> | undefined;
  lastUsage: Record<string, unknown> | undefined;
} {
  const info = narrowRecordField(payload["info"], "token_count.info");
  return {
    totalUsage: info
      ? narrowRecordField(info["total_token_usage"], "token_count.total_token_usage")
      : undefined,
    lastUsage: info
      ? narrowRecordField(info["last_token_usage"], "token_count.last_token_usage")
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function resolveToolIdentity(
  name: string,
  namespace: unknown,
): { tool: string; metadata?: { name: string; namespace: string } } {
  const mappedName = CODEX_TOOL_TITLE_MAP[name];
  if (mappedName) return { tool: mappedName };

  const namespaceText = typeof namespace === "string" ? namespace.trim() : "";
  if (!namespaceText) return { tool: name };

  const namespaceName = namespaceText.split("__").at(-1) ?? namespaceText;
  const toolName = name.replace(/^[_.]+/, "");
  if (!namespaceName) {
    return {
      tool: toolName || name,
      metadata: { name, namespace: namespaceText },
    };
  }

  return {
    tool: `${namespaceName}.${toolName || name}`,
    metadata: { name, namespace: namespaceText },
  };
}

function normalizeCustomToolArguments(toolName: string, input: unknown): unknown {
  if (toolName === "apply_patch") {
    return parseApplyPatchInput(input);
  }
  return input;
}

/**
 * Flatten tool-call output to text. Classic outputs are strings; code-mode
 * outputs are arrays of `{ type: "input_text", text }` segments.
 */
function flattenOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === "string") return item;
        const record = asRecord(item);
        return record ? (asString(record["text"]) ?? "") : "";
      })
      .join("");
  }
  return "";
}

function extractAssistantOutputText(payload: Record<string, unknown>): string {
  const content = payload["content"];
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item);
        return record && String(record["type"] ?? "") === "output_text"
          ? String(record["text"] ?? "")
          : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

interface PatchBlock {
  type: "write_file" | "delete_file" | "move_file" | "edit_file";
  path?: string;
  content?: string;
  targetPath?: string;
}

const PATCH_BEGIN_RE = /\*\*\* Begin Patch/;
const PATCH_END_RE = /\*\*\* End Patch/;
const PATCH_HEADER_RE = /\*\*\*\s+(Add|Delete|Update|Move)\s+File:\s*(.+)/;
const PATCH_MOVE_TO_RE = /\*\*\*\s+Move to:\s*(.+)/;

function parseApplyPatchInput(input: unknown): PatchBlock[] {
  const text = typeof input === "string" ? input : "";
  if (!text) return [];

  const blocks: PatchBlock[] = [];
  const lines = text.split("\n");
  let inPatch = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!inPatch && PATCH_BEGIN_RE.test(line)) {
      inPatch = true;
      i++;
      continue;
    }

    if (inPatch && PATCH_END_RE.test(line)) {
      inPatch = false;
      i++;
      continue;
    }

    if (inPatch) {
      const headerMatch = line.match(PATCH_HEADER_RE);
      if (headerMatch) {
        const action = headerMatch[1]!;
        const filePath = headerMatch[2]!.trim();
        i++;

        if (action === "Add") {
          const content = extractPatchContent(lines, i);
          i = content.nextLineIndex;
          blocks.push({ type: "write_file", path: filePath, content: content.text });
        } else if (action === "Update") {
          // Check for Move to on the next non-empty line
          let moveToTarget: string | null = null;
          let contentStart = i;
          for (let j = i; j < lines.length; j++) {
            const l = lines[j]!;
            if (!l.trim()) continue;
            const moveMatch = l.match(PATCH_MOVE_TO_RE);
            if (moveMatch) {
              moveToTarget = moveMatch[1]!.trim();
              contentStart = j + 1;
              break;
            }
            break;
          }
          if (moveToTarget) {
            const content = extractPatchContent(lines, contentStart);
            i = content.nextLineIndex;
            blocks.push({
              type: "move_file",
              path: filePath,
              targetPath: moveToTarget,
              content: content.text,
            });
          } else {
            const content = extractPatchContent(lines, i);
            i = content.nextLineIndex;
            blocks.push({ type: "edit_file", path: filePath, content: content.text });
          }
        } else if (action === "Delete") {
          blocks.push({ type: "delete_file", path: filePath });
          // No content to read for delete
        }
        continue;
      }
    }

    i++;
  }

  return blocks;
}

function extractPatchContent(
  lines: string[],
  startIndex: number,
): { text: string; nextLineIndex: number } {
  const contentLines: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i]!;
    // Stop at next patch header or end patch
    if (PATCH_HEADER_RE.test(line) || PATCH_END_RE.test(line)) break;
    contentLines.push(line);
    i++;
  }
  return { text: contentLines.join("\n"), nextLineIndex: i };
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

export class CodexAgent extends SingleFileSessionSource<SessionMeta> {
  readonly name = "codex";
  readonly displayName = "Codex";

  private basePath: string | null = null;
  private sessionIndexCache = new Map<string, string>();
  private sessionIndexMtime: number | null | undefined;
  private sessionIndexPath: string | undefined;
  private subagentIndex: SubagentIndex | null = null;
  private subagentStatsByParent = new Map<string, SessionHead["stats"][]>();
  private childFinalMessagesByParent = new Map<string, Map<string, ChildFinalMessageCacheEntry>>();

  // ---- BaseAgent implementation ----

  private findBasePath(): string | null {
    return firstExisting(join(resolveCodexDataRoot(), "sessions"));
  }

  getSessionWatchPlan() {
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

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    super.setSessionMetaMap(meta);
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
      const firstLine = readLeadingJsonlLines(filePath, 1)[0];
      if (!firstLine) return null;
      return extractThreadMeta(JSON.parse(firstLine));
    } catch (error) {
      getCoreDiagnostics()?.warn("codex.thread_meta_read_failed", {
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private parseTokenStats(filePath: string): SessionHead["stats"] {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;
    let activeModel: string | null = null;

    let prevCumulativeTotal = 0;
    let prevInput = 0;
    let prevOutput = 0;
    let prevReasoning = 0;
    let prevCachedInput = 0;

    for (const line of readJsonlFileLines(filePath)) {
      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        const payload = extractPayload(data);

        if (recordType === "session_meta" || recordType === "turn_context") {
          const nextModel = extractModelName(payload["model"]);
          if (nextModel) activeModel = nextModel;
          continue;
        }

        if (recordType === "event_msg" && String(payload["type"] ?? "") === "token_count") {
          const { totalUsage, lastUsage } = extractTokenUsage(payload);
          const cumulativeTotal = Number(totalUsage?.["total_tokens"] ?? 0);
          if (cumulativeTotal <= 0 || cumulativeTotal === prevCumulativeTotal) continue;
          prevCumulativeTotal = cumulativeTotal;

          let inputTokens = 0;
          let outputTokens = 0;
          let reasoningTokens = 0;
          let cacheReadTokens = 0;

          if (lastUsage) {
            inputTokens = Number(lastUsage["input_tokens"] ?? 0);
            outputTokens = Number(lastUsage["output_tokens"] ?? 0);
            reasoningTokens = Number(lastUsage["reasoning_output_tokens"] ?? 0);
            cacheReadTokens = extractCachedInputTokens(lastUsage);
          } else if (totalUsage) {
            inputTokens = Number(totalUsage["input_tokens"] ?? 0) - prevInput;
            outputTokens = Number(totalUsage["output_tokens"] ?? 0) - prevOutput;
            reasoningTokens = Number(totalUsage["reasoning_output_tokens"] ?? 0) - prevReasoning;
            cacheReadTokens = extractCachedInputTokens(totalUsage) - prevCachedInput;
            prevInput = Number(totalUsage["input_tokens"] ?? 0);
            prevOutput = Number(totalUsage["output_tokens"] ?? 0);
            prevReasoning = Number(totalUsage["reasoning_output_tokens"] ?? 0);
            prevCachedInput = extractCachedInputTokens(totalUsage);
          }

          const totalInput = Math.max(0, inputTokens);
          const totalCacheRead = Math.max(0, cacheReadTokens);
          totalInputTokens += totalInput;
          totalOutputTokens += outputTokens + reasoningTokens;
          totalCacheReadTokens += totalCacheRead;
          totalCost +=
            estimateTokenCost(activeModel, {
              input: totalInput,
              output: outputTokens,
              reasoning: reasoningTokens || undefined,
              cache_read: totalCacheRead || undefined,
            }) ?? 0;
        }
      } catch {
        // skip malformed records
      }
    }

    return {
      message_count: 0,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cache_read_tokens: totalCacheReadTokens || undefined,
      total_cost: totalCost,
      cost_source: totalCost > 0 ? "estimated" : undefined,
    };
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);
    this.basePath ??= this.findBasePath();

    const transcript = new TranscriptBuilder();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;

    let pendingPlan: MessagePart | null = null;
    let activeModel: string | null = null;

    // Token-count dedup state (matches codeburn strategy)
    let prevCumulativeTotal = 0;
    let prevInput = 0;
    let prevOutput = 0;
    let prevReasoning = 0;
    let prevCachedInput = 0;

    for (const record of readJsonlFile(meta.sourcePath)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType === "session_meta" || recordType === "turn_context") {
          const payload = extractPayload(record);
          activeModel = extractModelName(payload["model"]) ?? activeModel;
        }

        pendingPlan = this.convertRecord(record, transcript, pendingPlan, activeModel);

        // Process Codex token_count events
        if (recordType === "event_msg") {
          const payload = extractPayload(record);
          if (String(payload["type"] ?? "") === "token_count") {
            const { totalUsage, lastUsage } = extractTokenUsage(payload);
            const cumulativeTotal = Number(totalUsage?.["total_tokens"] ?? 0);

            if (cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal) {
              // duplicate event
            } else {
              prevCumulativeTotal = cumulativeTotal;

              let inputTokens = 0;
              let outputTokens = 0;
              let reasoningTokens = 0;
              let cacheReadTokens = 0;

              if (lastUsage) {
                inputTokens = Number(lastUsage["input_tokens"] ?? 0);
                outputTokens = Number(lastUsage["output_tokens"] ?? 0);
                reasoningTokens = Number(lastUsage["reasoning_output_tokens"] ?? 0);
                cacheReadTokens = extractCachedInputTokens(lastUsage);
              } else if (cumulativeTotal > 0 && totalUsage) {
                inputTokens = Number(totalUsage["input_tokens"] ?? 0) - prevInput;
                outputTokens = Number(totalUsage["output_tokens"] ?? 0) - prevOutput;
                reasoningTokens =
                  Number(totalUsage["reasoning_output_tokens"] ?? 0) - prevReasoning;
                cacheReadTokens = extractCachedInputTokens(totalUsage) - prevCachedInput;

                prevInput = Number(totalUsage["input_tokens"] ?? 0);
                prevOutput = Number(totalUsage["output_tokens"] ?? 0);
                prevReasoning = Number(totalUsage["reasoning_output_tokens"] ?? 0);
                prevCachedInput = extractCachedInputTokens(totalUsage);
              }

              const totalInput = Math.max(0, inputTokens);
              const totalCacheRead = Math.max(0, cacheReadTokens);
              if (totalInput || outputTokens || reasoningTokens) {
                totalInputTokens += totalInput;
                totalOutputTokens += outputTokens + reasoningTokens;
                totalCacheReadTokens += totalCacheRead;

                const tokens = {
                  input: totalInput,
                  output: outputTokens,
                  reasoning: reasoningTokens || undefined,
                  cache_read: totalCacheRead || undefined,
                };
                const cost = estimateTokenCost(activeModel, tokens);
                transcript.attachUsageToLatestAssistant(tokens, {
                  model: activeModel,
                  cost: cost ?? undefined,
                  costSource: cost === null ? undefined : "estimated",
                });
                totalCost += cost ?? 0;
              }
            }
          }
        }
      } catch {
        // skip malformed records
      }
    }

    if (pendingPlan) transcript.appendToCurrentAssistant(pendingPlan);
    const result = transcript.finish({
      message_count: 0,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cache_read_tokens: totalCacheReadTokens || undefined,
      total_cost: totalCost,
      cost_source: totalCost > 0 ? "estimated" : undefined,
    });

    this.applyChildStats(result.stats, meta.id);

    const childMessages = this.collectChildMessages(meta.id);
    this.mergeChildMessages(result.messages, childMessages);
    result.stats.message_count = result.messages.length;

    return {
      reference: { agentName: this.name, sessionId: meta.id },
      id: meta.id,
      title: meta.title,
      slug: this.sessionSlug(meta.id),
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
    for (const file of this.listRolloutFilePaths()) {
      const threadMeta = this.readThreadMeta(file);
      if (threadMeta?.threadSource !== "subagent") continue;
      index.subagentFiles.add(file);
      if (!threadMeta.parentThreadId) continue;
      const files = index.childFilesByParent.get(threadMeta.parentThreadId);
      if (files) files.push(file);
      else index.childFilesByParent.set(threadMeta.parentThreadId, [file]);
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

    for (const record of readJsonlFile(filePath)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType !== "response_item") continue;
        const payload = extractPayload(record);
        if (String(payload["type"] ?? "") !== "message") continue;
        if (String(payload["role"] ?? "") !== "assistant") continue;

        const text = cleanInternalText(extractAssistantOutputText(payload));
        if (!text) continue;

        const candidate: ChildOutput = {
          id: asString(payload["id"]) ?? `codex-subagent-${sessionId}`,
          text,
          timestampMs:
            parseTimestampMs(record) || parseTimestampMs(payload) || statSync(filePath).mtimeMs,
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
    } catch {
      this.sessionIndexCache.clear();
      this.sessionIndexMtime = undefined;
    }
  }

  private getTitleForSession(sessionId: string): string | null {
    return this.sessionIndexCache.get(sessionId) ?? null;
  }

  // ---- Session head parsing ----

  protected parseFileSessionHead(filePath: string, options?: AgentScanOptions): SessionHead | null {
    return this.parseSessionHead(filePath, options);
  }

  private parseSessionHead(filePath: string, options?: AgentScanOptions): SessionHead | null {
    return getParsedSession(this.parseFileSessionHeadResult(filePath, options));
  }

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
    const modelUsageMap: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;

    let scanPrevCumulativeTotal = 0;
    let scanPrevInput = 0;
    let scanPrevOutput = 0;
    let scanPrevReasoning = 0;
    let scanPrevCachedInput = 0;

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
        firstPayload = extractPayload(firstRecord);
        const threadMeta = extractThreadMeta(firstRecord);
        parentThreadId = threadMeta?.threadSource === "subagent" ? threadMeta.parentThreadId : null;
        createdAt =
          parseTimestampMs(firstRecord) ||
          parseTimestampMs(firstPayload) ||
          statSync(filePath).mtimeMs;
        updatedAt = createdAt;
      }

      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        const payload = extractPayload(data);
        const payloadType = String(payload["type"] ?? "");
        if (isInternalEventType(recordType) || isInternalEventType(payloadType)) continue;
        hasNonInternalRecord = true;
        const recordTs = parseTimestampMs(data) || parseTimestampMs(payload);
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
            const { totalUsage, lastUsage } = extractTokenUsage(payload);
            const cumulativeTotal = Number(totalUsage?.["total_tokens"] ?? 0);

            if (cumulativeTotal > 0 && cumulativeTotal !== scanPrevCumulativeTotal) {
              scanPrevCumulativeTotal = cumulativeTotal;

              let inputTokens = 0;
              let outputTokens = 0;
              let reasoningTokens = 0;
              let cacheReadTokens = 0;

              if (lastUsage) {
                inputTokens = Number(lastUsage["input_tokens"] ?? 0);
                outputTokens = Number(lastUsage["output_tokens"] ?? 0);
                reasoningTokens = Number(lastUsage["reasoning_output_tokens"] ?? 0);
                cacheReadTokens = extractCachedInputTokens(lastUsage);
              } else if (cumulativeTotal > 0 && totalUsage) {
                inputTokens = Number(totalUsage["input_tokens"] ?? 0) - scanPrevInput;
                outputTokens = Number(totalUsage["output_tokens"] ?? 0) - scanPrevOutput;
                reasoningTokens =
                  Number(totalUsage["reasoning_output_tokens"] ?? 0) - scanPrevReasoning;
                cacheReadTokens = extractCachedInputTokens(totalUsage) - scanPrevCachedInput;

                scanPrevInput = Number(totalUsage["input_tokens"] ?? 0);
                scanPrevOutput = Number(totalUsage["output_tokens"] ?? 0);
                scanPrevReasoning = Number(totalUsage["reasoning_output_tokens"] ?? 0);
                scanPrevCachedInput = extractCachedInputTokens(totalUsage);
              }

              const totalInput = Math.max(0, inputTokens);
              const totalCacheRead = Math.max(0, cacheReadTokens);
              totalInputTokens += totalInput;
              totalOutputTokens += outputTokens + reasoningTokens;
              totalCacheReadTokens += totalCacheRead;
              const totalForModel = totalInput + outputTokens + reasoningTokens;
              if (activeModel && totalForModel > 0) {
                modelUsageMap[activeModel] = (modelUsageMap[activeModel] ?? 0) + totalForModel;
              }
              const cost = estimateTokenCost(activeModel, {
                input: totalInput,
                output: outputTokens,
                reasoning: reasoningTokens || undefined,
                cache_read: totalCacheRead || undefined,
              });
              if (cost !== null) totalCost += cost;
            }
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
      id: sessionId,
      slug: this.sessionSlug(sessionId),
      title,
      directory,
      parent_reference:
        parentThreadId == null ? undefined : { agentName: this.name, sessionId: parentThreadId },
      time_created: createdAt,
      time_updated: updatedAt,
      stats: {
        message_count: messageCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cache_read_tokens: totalCacheReadTokens || undefined,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
      },
      model_usage: Object.keys(modelUsageMap).length > 0 ? modelUsageMap : undefined,
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

    const payload = extractPayload(firstRecord);
    const stat = statSync(filePath);
    const createdAt = parseTimestampMs(firstRecord) || parseTimestampMs(payload) || stat.mtimeMs;
    const indexTitle = this.getTitleForSession(sessionId);
    const messageTitle = this.extractTitleFromLines(lines);
    const directory = payload["cwd"] ? String(payload["cwd"]) : "";
    const directoryTitle = basenameTitle(directory || null);
    const title = resolveSessionTitle(indexTitle, messageTitle, directoryTitle);

    return parsedSession({
      id: sessionId,
      slug: this.sessionSlug(sessionId),
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

    const payload = extractPayload(data);
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

  // ---- Record conversion ----

  private convertRecord(
    data: Record<string, unknown>,
    transcript: TranscriptBuilder,
    pendingPlan: MessagePart | null,
    activeModel: string | null,
  ): MessagePart | null {
    const recordType = String(data["type"] ?? "");
    if (isInternalEventType(recordType)) return pendingPlan;

    if (recordType === "session_meta" || recordType === "event_msg") {
      return pendingPlan;
    }

    if (recordType !== "response_item") return pendingPlan;

    const payload = extractPayload(data);
    const payloadType = String(payload["type"] ?? "");
    if (isInternalEventType(payloadType)) return pendingPlan;
    const timestampMs = parseTimestampMs(data) || parseTimestampMs(payload);

    switch (payloadType) {
      case "message": {
        const role = String(payload["role"] ?? "");
        if (role === "assistant") {
          return this.convertAssistantMessage(
            payload,
            transcript,
            timestampMs,
            pendingPlan,
            activeModel,
          );
        }
        if (role === "user") {
          return this.convertUserMessage(payload, transcript, timestampMs, pendingPlan);
        }
        break;
      }

      case "reasoning":
        this.convertReasoning(payload, transcript, timestampMs, activeModel);
        return null;

      case "function_call":
        this.convertFunctionCall(payload, transcript, timestampMs, activeModel);
        return null;

      case "function_call_output":
        this.convertToolCallOutput(payload, transcript, timestampMs);
        return pendingPlan;

      case "custom_tool_call":
        this.convertCustomToolCall(payload, transcript, timestampMs, activeModel);
        return null;

      case "custom_tool_call_output":
        this.convertToolCallOutput(payload, transcript, timestampMs);
        return pendingPlan;
    }

    return pendingPlan;
  }

  // ---- Assistant message ----

  private convertAssistantMessage(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    pendingPlan: MessagePart | null,
    activeModel: string | null,
  ): MessagePart | null {
    const fullText = extractAssistantOutputText(payload);
    if (!fullText) return pendingPlan;

    const planMatch = fullText.match(PROPOSED_PLAN_PATTERN);
    if (planMatch) {
      const planText = planMatch[1]!.trim();
      const planPart: MessagePart = {
        type: "plan",
        text: planText,
        approval_status: "success",
        time_created: timestampMs,
      };
      pendingPlan = planPart;
    }

    const displayText = cleanInternalText(fullText.replace(PROPOSED_PLAN_PATTERN, ""));
    if (!displayText) return pendingPlan;

    const textPart: MessagePart = { type: "text", text: displayText, time_created: timestampMs };
    transcript.appendAssistantPart(textPart, {
      id: "",
      timestampMs,
      agent: "codex",
      model: activeModel,
    });
    return pendingPlan;
  }

  // ---- User message ----

  private convertUserMessage(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    pendingPlan: MessagePart | null,
  ): MessagePart | null {
    const content = payload["content"];
    const text = Array.isArray(content)
      ? content
          .map((c) => {
            if (Array.isArray(c)) return "";
            const record = asRecord(c);
            return record ? String(record["text"] ?? "") : String(c ?? "");
          })
          .join(" ")
      : String(content ?? "");

    const visibleText = cleanInternalText(text);
    if (!visibleText) return pendingPlan;

    if (isDeveloperLikeUserMessage(visibleText)) return pendingPlan;

    if (visibleText.trimStart().startsWith(PLAN_APPROVAL_PREFIX)) {
      if (pendingPlan) transcript.appendToCurrentAssistant(pendingPlan);
      transcript.appendMessage({
        id: "",
        role: "user",
        timestampMs,
        parts: [{ type: "text", text: visibleText, time_created: timestampMs }],
      });
      return null;
    }

    const subagentMatch = visibleText.match(SUBAGENT_NOTIFICATION_PATTERN);
    if (subagentMatch) {
      // Malformed or non-object notification payloads fall through and are
      // treated as normal user messages below.
      let notifPayload: Record<string, unknown> | undefined;
      try {
        notifPayload = asRecord(JSON.parse(subagentMatch[1]!));
      } catch {
        notifPayload = undefined;
      }

      if (notifPayload) {
        const agentId = String(notifPayload["agent_id"] ?? "");
        const nickname = String(notifPayload["nickname"] ?? "");
        const completedText = String(notifPayload["completed"] ?? "");

        const textPart: MessagePart = {
          type: "text",
          text: completedText || `Subagent ${nickname} completed`,
          time_created: timestampMs,
        };

        transcript.appendMessage({
          id: "",
          role: "assistant",
          timestampMs,
          parts: [textPart],
          agent: "codex",
          subagentId: agentId || undefined,
          nickname: nickname || undefined,
        });
        transcript.beginTurn();
        return pendingPlan;
      }
    }

    transcript.appendMessage({
      id: "",
      role: "user",
      timestampMs,
      parts: [{ type: "text", text: visibleText, time_created: timestampMs }],
    });
    return pendingPlan;
  }

  // ---- Reasoning ----

  private convertReasoning(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const summary = payload["summary"];
    if (!Array.isArray(summary)) return;

    const texts: string[] = [];
    for (const item of summary) {
      const ci = asRecord(item);
      if (!ci) continue;
      if (String(ci["type"] ?? "") === "summary_text") {
        const text = String(ci["text"] ?? "");
        if (text.trim()) texts.push(text);
      }
    }

    if (texts.length === 0) return;

    const reasoningText = texts.join("\n");
    const part: MessagePart = { type: "reasoning", text: reasoningText, time_created: timestampMs };
    transcript.appendAssistantPart(
      part,
      {
        id: "",
        timestampMs,
        agent: "codex",
        model: activeModel,
      },
      { resetLatestText: true },
    );
  }

  // ---- Function call ----

  private convertFunctionCall(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) return;

    const toolIdentity = resolveToolIdentity(name, payload["namespace"]);
    const arguments_ = normalizeToolArguments(payload["arguments"]);

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: arguments_,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }

  // ---- Function call output ----

  private convertToolCallOutput(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    if (!callId) return;

    const outputText = cleanInternalText(
      stripExecOutputEnvelope(flattenOutputText(payload["output"])),
    );
    const outputParts: MessagePart[] = outputText
      ? [{ type: "text", text: outputText, time_created: timestampMs }]
      : [];

    if (outputParts.length > 0) {
      transcript.resolveToolCall(callId, { output: outputParts, status: "completed" });
    }
  }

  // ---- Custom tool call ----

  private convertCustomToolCall(
    payload: Record<string, unknown>,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) return;

    // Code-mode exec: the JS program wraps native tool calls. Decode each
    // inner call back to its classic tool part so existing displays apply.
    // Programs with no recognizable call fall through to the raw exec part.
    if (name === "exec") {
      const decoded = decodeExecCalls(payload["input"]);
      if (decoded.length > 0) {
        this.appendDecodedExecCalls(decoded, callId, transcript, timestampMs, activeModel);
        return;
      }
    }

    const toolIdentity = resolveToolIdentity(name, payload["namespace"]);
    const rawInput = payload["input"];
    const normalizedInput = normalizeCustomToolArguments(name, rawInput);

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: normalizedInput,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }

  // ---- Decoded code-mode exec calls ----

  private appendDecodedExecCalls(
    calls: ExecInnerCall[],
    callId: string,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    // Only one output record follows, keyed by the exec call id; route it to
    // the output-bearing part and give the rest unique ids so they still
    // register and render, just without a resolved output.
    const outputIndex = pickExecOutputTarget(calls);
    calls.forEach((call, index) => {
      const partCallId = index === outputIndex ? callId : `${callId}#${index}`;
      this.appendDecodedExecCall(call, partCallId, transcript, timestampMs, activeModel);
    });
  }

  private appendDecodedExecCall(
    call: ExecInnerCall,
    callId: string,
    transcript: TranscriptBuilder,
    timestampMs: number,
    activeModel: string | null,
  ): void {
    const { name, namespace } = splitExecToolName(call.name);
    const toolIdentity = resolveToolIdentity(name, namespace);
    const arguments_ =
      name === "apply_patch" ? parseApplyPatchInput(getExecPatchText(call.args)) : call.args;

    const toolPart: MessagePart = {
      type: "tool",
      tool: toolIdentity.tool,
      callID: callId,
      title: `Tool: ${toolIdentity.tool}`,
      state: {
        status: "running",
        input: arguments_,
        output: null,
        metadata: toolIdentity.metadata,
      },
      time_created: timestampMs,
    };

    transcript.appendToolCall(
      toolPart,
      { id: "", timestampMs, agent: "codex", model: activeModel },
      { markModeAsTool: true },
    );
  }
}
