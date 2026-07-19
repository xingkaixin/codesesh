import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import {
  FileSystemSessionSource,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
  skippedSession,
} from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type { SessionHead, SessionData, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { parseJsonlLines, readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { cleanInternalText, isInternalEventType } from "../utils/session-normalization.js";
import { estimateTokenCost } from "../utils/cost.js";
import { TranscriptBuilder } from "./transcript-builder.js";
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
const PARSER_VERSION = "codex-parser-v4";

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
  const ts = String(data["timestamp"] ?? "").trim();
  if (!ts) return 0;
  try {
    return new Date(ts.includes("Z") ? ts : ts.replace(" ", "T") + "Z").getTime();
  } catch {
    return 0;
  }
}

function extractModelName(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function extractCachedInputTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return Number(usage["cached_input_tokens"] ?? usage["cache_read_input_tokens"] ?? 0);
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
        if (item && typeof item === "object") {
          const text = (item as Record<string, unknown>)["text"];
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("");
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

import type { AgentScanOptions, SessionCacheMeta, SessionSourceRef } from "./base.js";

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  sourceMtimeMs: number;
  indexPath: string | null;
  indexMtimeMs: number | null;
  headIndexVersion: string;
  parserVersion: string;
  directory: string;
  model: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// CodexAgent
// ---------------------------------------------------------------------------

export class CodexAgent extends FileSystemSessionSource<SessionMeta> {
  readonly name = "codex";
  readonly displayName = "Codex";

  private basePath: string | null = null;
  private sessionIndexCache = new Map<string, string>();
  private sessionIndexMtime: number | null = null;

  // ---- BaseAgent implementation ----

  private findBasePath(): string | null {
    const roots = resolveProviderRoots();
    return firstExisting(join(roots.codexRoot, "sessions"));
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    try {
      // Check recursively for rollout jsonl files
      const files = this.walkDirForRolloutFiles(this.basePath);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    this.loadSessionIndex();
    return this.listRolloutFiles(options).map((file) => ({
      sessionId: extractSessionId(file),
      sourcePath: file,
      fingerprint: this.sourceFingerprint(file),
    }));
  }

  scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null {
    this.loadSessionIndex();
    const head = getParsedSession(this.parseSessionHeadResult(sourcePath, options));
    if (head) {
      this.sessionMetaMap.set(head.id, this.buildSessionMeta(head, sourcePath));
    }
    return head;
  }

  getSessionData(sessionId: string): SessionData {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);

    const transcript = new TranscriptBuilder();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;

    let pendingPlan: MessagePart | null = null;
    let activeModel: string | null = meta.model;

    // Token-count dedup state (matches codeburn strategy)
    let prevCumulativeTotal = 0;
    let prevInput = 0;
    let prevOutput = 0;
    let prevReasoning = 0;
    let prevCachedInput = 0;

    for (const record of readJsonlFile(meta.sourcePath)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType === "turn_context") {
          const payload = (record["payload"] ?? {}) as Record<string, unknown>;
          activeModel = extractModelName(payload["model"]) ?? activeModel;
        }

        pendingPlan = this.convertRecord(record, transcript, pendingPlan, activeModel);

        // Process Codex token_count events
        if (recordType === "event_msg") {
          const payload = (record["payload"] ?? {}) as Record<string, unknown>;
          if (String(payload["type"] ?? "") === "token_count") {
            const info = payload["info"] as Record<string, unknown> | undefined;
            const totalUsage = info?.["total_token_usage"] as Record<string, unknown> | undefined;
            const cumulativeTotal = Number(totalUsage?.["total_tokens"] ?? 0);

            if (cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal) {
              // duplicate event
            } else {
              prevCumulativeTotal = cumulativeTotal;

              const lastUsage = info?.["last_token_usage"] as Record<string, unknown> | undefined;
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

    return {
      id: meta.id,
      title: meta.title,
      slug: `codex/${meta.id}`,
      directory: meta.directory,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: result.stats,
      messages: result.messages,
    };
  }

  // ---- File listing ----

  private listRolloutFiles(options?: AgentScanOptions): string[] {
    if (!this.basePath) return [];
    try {
      return this.walkDirForRolloutFiles(this.basePath, options);
    } catch {
      return [];
    }
  }

  private walkDirForRolloutFiles(dir: string, options?: AgentScanOptions): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.walkDirForRolloutFiles(fullPath, options));
        } else if (entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) {
          if (options?.from != null || options?.to != null) {
            try {
              if (!matchesScanWindow(statSync(fullPath).mtimeMs, options)) continue;
            } catch {
              continue;
            }
          }
          files.push(fullPath);
        }
      }
    } catch {
      // skip permission errors
    }
    return files;
  }

  private buildSessionMeta(head: SessionHead, file: string): SessionMeta {
    const indexPath = this.getSessionIndexPath();
    return {
      id: head.id,
      title: head.title,
      sourcePath: file,
      sourceFingerprint: this.sourceFingerprint(file),
      sourceMtimeMs: statSync(file).mtimeMs,
      indexPath: existsSync(indexPath) ? indexPath : null,
      indexMtimeMs: this.getFileMtimeMs(indexPath),
      headIndexVersion: HEAD_INDEX_VERSION,
      parserVersion: PARSER_VERSION,
      directory: head.directory,
      model: null,
      messageCount: head.stats.message_count,
      createdAt: head.time_created,
      updatedAt: head.time_updated ?? head.time_created,
    };
  }

  private sourceFingerprint(file: string): string {
    const stat = statSync(file);
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
    const roots = resolveProviderRoots();
    return join(roots.codexRoot, "session_index.jsonl");
  }

  private getFileMtimeMs(filePath: string): number | null {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  // ---- Session index ----

  private loadSessionIndex(): void {
    const indexPath = this.getSessionIndexPath();
    const mtime = this.getFileMtimeMs(indexPath);

    // Invalidate when the index file mtime advances so long-running processes
    // pick up title changes without relying on callers to evict manually.
    if (this.sessionIndexCache.size > 0 && this.sessionIndexMtime === mtime) return;

    this.sessionIndexCache.clear();
    this.sessionIndexMtime = mtime;
    if (mtime === null) return;

    try {
      const content = readFileSync(indexPath, "utf-8");
      for (const record of parseJsonlLines(content)) {
        const sid = String(record["id"] ?? "").trim();
        const threadName = String(record["thread_name"] ?? "").trim();
        if (sid && threadName) {
          this.sessionIndexCache.set(sid, threadName);
        }
      }
    } catch {
      // ignore
    }
  }

  private getTitleForSession(sessionId: string): string | null {
    this.loadSessionIndex();
    return this.sessionIndexCache.get(sessionId) ?? null;
  }

  // ---- Session head parsing ----

  private readFilePrefix(filePath: string, bytes = 64 * 1024): string {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const bytesRead = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  }

  private parseSessionHead(filePath: string, options?: AgentScanOptions): SessionHead | null {
    return getParsedSession(this.parseSessionHeadResult(filePath, options));
  }

  private parseSessionHeadResult(
    filePath: string,
    options?: AgentScanOptions,
  ): ParseSessionResult<SessionHead> {
    if (options?.fast) {
      return this.parseFastSessionHeadResult(filePath);
    }

    const sessionId = extractSessionId(filePath);

    let firstPayload: Record<string, unknown> = {};
    let createdAt = 0;
    let lineCount = 0;
    const titleLines: string[] = [];

    // Single streaming pass: read the first record, buffer title candidates,
    // count messages, extract models, and pre-accumulate tokens.
    let updatedAt = 0;
    let messageCount = 0;
    let model: string | null = null;
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
        firstPayload = (firstRecord["payload"] ?? {}) as Record<string, unknown>;
        createdAt =
          parseTimestampMs(firstRecord) ||
          parseTimestampMs(firstPayload) ||
          statSync(filePath).mtimeMs;
        updatedAt = createdAt;
      }
      if (titleLines.length < 20) titleLines.push(line);

      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        const payload = (data["payload"] ?? {}) as Record<string, unknown>;
        const payloadType = String(payload["type"] ?? "");
        if (isInternalEventType(recordType) || isInternalEventType(payloadType)) continue;
        hasNonInternalRecord = true;
        const recordTs =
          parseTimestampMs(data) ||
          parseTimestampMs((data["payload"] ?? {}) as Record<string, unknown>);
        if (recordTs > updatedAt) updatedAt = recordTs;

        if (recordType === "session_meta" || recordType === "turn_context") {
          const nextModel = extractModelName(payload["model"]);
          if (nextModel) {
            activeModel = nextModel;
            model ??= nextModel;
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
          const info = p["info"] as Record<string, unknown> | undefined;
          const m = info?.["model"] ?? p["model"];
          if (typeof m === "string" && m.trim()) {
            activeModel = m.trim();
            model ??= activeModel;
          }
        }

        if (recordType === "event_msg") {
          const p = (data["payload"] ?? {}) as Record<string, unknown>;
          if (String(p["type"] ?? "") === "token_count") {
            const info = p["info"] as Record<string, unknown> | undefined;
            const totalUsage = info?.["total_token_usage"] as Record<string, unknown> | undefined;
            const cumulativeTotal = Number(totalUsage?.["total_tokens"] ?? 0);

            if (cumulativeTotal > 0 && cumulativeTotal !== scanPrevCumulativeTotal) {
              scanPrevCumulativeTotal = cumulativeTotal;

              const lastUsage = info?.["last_token_usage"] as Record<string, unknown> | undefined;
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
    const messageTitle = this.extractTitleFromLines(titleLines);
    const directory = firstPayload["cwd"] ? String(firstPayload["cwd"]) : "";
    const title = resolveSessionTitle(indexTitle, messageTitle, basenameTitle(directory || null));

    return parsedSession({
      id: sessionId,
      slug: `codex/${sessionId}`,
      title,
      directory,
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

  private parseFastSessionHead(filePath: string): SessionHead | null {
    return getParsedSession(this.parseFastSessionHeadResult(filePath));
  }

  private parseFastSessionHeadResult(filePath: string): ParseSessionResult<SessionHead> {
    const prefix = this.readFilePrefix(filePath);
    const lines = prefix.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return skippedSession("empty file");

    const sessionId = extractSessionId(filePath);

    let firstRecord: Record<string, unknown>;
    try {
      firstRecord = JSON.parse(lines[0]!);
    } catch {
      return skippedSession("malformed first record");
    }

    const payload = (firstRecord["payload"] ?? {}) as Record<string, unknown>;
    const stat = statSync(filePath);
    const createdAt = parseTimestampMs(firstRecord) || parseTimestampMs(payload) || stat.mtimeMs;
    const indexTitle = this.getTitleForSession(sessionId);
    const messageTitle = this.extractTitleFromLines(lines);
    const directory = payload["cwd"] ? String(payload["cwd"]) : "";
    const directoryTitle = basenameTitle(directory || null);
    const title = resolveSessionTitle(indexTitle, messageTitle, directoryTitle);

    return parsedSession({
      id: sessionId,
      slug: `codex/${sessionId}`,
      title,
      directory,
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

  private extractTitleFromLines(lines: string[]): string | null {
    for (const line of lines.slice(0, 20)) {
      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        if (recordType !== "response_item" || isInternalEventType(recordType)) continue;

        const payload = (data["payload"] ?? {}) as Record<string, unknown>;
        const pType = String(payload["type"] ?? "");
        if (pType !== "message" || isInternalEventType(pType)) continue;
        if (String(payload["role"] ?? "") !== "user") continue;

        const content = payload["content"];
        let text: string | null = null;
        if (Array.isArray(content)) {
          text = content
            .filter((item) => typeof item === "object" && item !== null && "text" in item)
            .map((item) => String((item as Record<string, unknown>)["text"] ?? ""))
            .join(" ");
        } else if (typeof content === "string") {
          text = content;
        }
        if (!text || isDeveloperLikeUserMessage(text)) continue;
        const title = normalizeTitleText(text);
        if (title) return title;
      } catch {
        // skip
      }
    }
    return null;
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

    const payload = (data["payload"] ?? {}) as Record<string, unknown>;
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
    const content = payload["content"];
    if (!Array.isArray(content)) return pendingPlan;

    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const ci = item as Record<string, unknown>;
      if (String(ci["type"] ?? "") === "output_text") {
        const text = String(ci["text"] ?? "");
        if (text.trim()) textParts.push(text);
      }
    }

    if (textParts.length === 0) return pendingPlan;

    const fullText = textParts.join("\n");

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
          .map((c) =>
            typeof c === "object" && c !== null
              ? String((c as Record<string, unknown>)["text"] ?? "")
              : String(c ?? ""),
          )
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
      try {
        const notifPayload = JSON.parse(subagentMatch[1]!) as Record<string, unknown>;
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
      } catch {
        // Treat malformed notification payloads as normal user messages.
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
      if (typeof item === "object" && item !== null) {
        const ci = item as Record<string, unknown>;
        if (String(ci["type"] ?? "") === "summary_text") {
          const text = String(ci["text"] ?? "");
          if (text.trim()) texts.push(text);
        }
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
        arguments: arguments_,
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
        arguments: normalizedInput,
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
        arguments: arguments_,
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
