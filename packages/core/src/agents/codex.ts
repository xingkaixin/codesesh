import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { BaseAgent } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { parseJsonlLines } from "../utils/jsonl.js";
import { resolveSessionTitle, basenameTitle } from "../utils/title-fallback.js";
import { perf } from "../utils/perf.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;
const PLAN_APPROVAL_PREFIX = "PLEASE IMPLEMENT THIS PLAN";
const SUBAGENT_NOTIFICATION_PATTERN =
  /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/;

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

// ---------------------------------------------------------------------------
// Title helpers
// ---------------------------------------------------------------------------

function normalizeTitleText(text: string): string {
  const line = text.split("\n").find((l) => l.trim());
  return line?.trim().slice(0, 80) || "";
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function mapToolTitle(name: string): string {
  return CODEX_TOOL_TITLE_MAP[name] ?? name;
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

import type { SessionCacheMeta, ChangeCheckResult } from "./base.js";

interface SessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  directory: string;
  model: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// CodexAgent
// ---------------------------------------------------------------------------

export class CodexAgent extends BaseAgent {
  readonly name = "codex";
  readonly displayName = "Codex";

  private basePath: string | null = null;
  private sessionIndexCache = new Map<string, string>();
  private sessionMetaMap = new Map<string, SessionMeta>();

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

  scan(): SessionHead[] {
    if (!this.basePath) return [];

    const scanMarker = perf.start("codex:scan");

    // Pre-load session index for titles
    const indexMarker = perf.start("loadSessionIndex");
    this.loadSessionIndex();
    perf.end(indexMarker);

    const heads: SessionHead[] = [];

    const listMarker = perf.start("listRolloutFiles");
    const files = this.listRolloutFiles();
    perf.end(listMarker);

    for (const file of files) {
      try {
        const parseMarker = perf.start(`parseSessionHead:${basename(file)}`);
        const head = this.parseSessionHead(file);
        perf.end(parseMarker);

        if (head) {
          heads.push(head);
          this.sessionMetaMap.set(head.id, {
            id: head.id,
            title: head.title,
            sourcePath: file,
            directory: head.directory,
            model: null,
            messageCount: head.stats.message_count,
            createdAt: head.time_created,
            updatedAt: head.time_updated ?? head.time_created,
          });
        }
      } catch {
        // skip malformed files
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
    if (!this.basePath) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    const changedIds: string[] = [];

    for (const session of cachedSessions) {
      const meta = this.sessionMetaMap.get(session.id);
      if (!meta) continue;

      try {
        const stat = statSync(meta.sourcePath);
        if (stat.mtimeMs > sinceTimestamp) {
          changedIds.push(session.id);
        }
      } catch {
        changedIds.push(session.id);
      }
    }

    // 检查新文件
    try {
      const allFiles = this.listRolloutFiles();
      const hasNewFiles = allFiles.length > cachedSessions.length;

      return {
        hasChanges: changedIds.length > 0 || hasNewFiles,
        changedIds,
        timestamp: Date.now(),
      };
    } catch {
      return {
        hasChanges: changedIds.length > 0,
        changedIds,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 增量扫描
   */
  incrementalScan(cachedSessions: SessionHead[], changedIds: string[]): SessionHead[] {
    if (!this.basePath) return cachedSessions;

    const sessionMap = new Map(cachedSessions.map((s) => [s.id, s]));

    // 重新扫描变更的会话
    for (const file of this.listRolloutFiles()) {
      try {
        const sessionId = extractSessionId(file);

        if (changedIds.includes(sessionId)) {
          const head = this.parseSessionHead(file);
          if (head) {
            sessionMap.set(head.id, head);
            this.sessionMetaMap.set(head.id, {
              id: head.id,
              title: head.title,
              sourcePath: file,
              directory: head.directory,
              model: null,
              messageCount: head.stats.message_count,
              createdAt: head.time_created,
              updatedAt: head.time_updated ?? head.time_created,
            });
          }
        }
      } catch {
        // skip
      }
    }

    // 检查新文件
    for (const file of this.listRolloutFiles()) {
      try {
        const sessionId = extractSessionId(file);
        if (!sessionMap.has(sessionId)) {
          const head = this.parseSessionHead(file);
          if (head) {
            sessionMap.set(head.id, head);
            this.sessionMetaMap.set(head.id, {
              id: head.id,
              title: head.title,
              sourcePath: file,
              directory: head.directory,
              model: null,
              messageCount: head.stats.message_count,
              createdAt: head.time_created,
              updatedAt: head.time_updated ?? head.time_created,
            });
          }
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
    if (!existsSync(meta.sourcePath)) throw new Error(`Session file missing: ${meta.sourcePath}`);

    const content = readFileSync(meta.sourcePath, "utf-8");
    const messages: Message[] = [];
    const pendingToolCalls = new Map<string, [number, number]>();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Assistant message grouping state
    let currentAssistantIndex: number | null = null;
    let latestAssistantTextIndex: number | null = null;
    let pendingPlan: MessagePart | null = null;
    let activeModel: string | null = meta.model;

    // Token-count dedup state (matches codeburn strategy)
    let prevCumulativeTotal = 0;
    let prevInput = 0;
    let prevOutput = 0;
    let prevReasoning = 0;

    for (const record of parseJsonlLines(content)) {
      try {
        const recordType = String(record["type"] ?? "");
        if (recordType === "turn_context") {
          const payload = (record["payload"] ?? {}) as Record<string, unknown>;
          activeModel = extractModelName(payload["model"]) ?? activeModel;
        }

        const result = this.convertRecord(
          record,
          messages,
          pendingToolCalls,
          meta.id,
          currentAssistantIndex,
          latestAssistantTextIndex,
          pendingPlan,
        );
        currentAssistantIndex = result.currentAssistantIndex;
        latestAssistantTextIndex = result.latestAssistantTextIndex;
        pendingPlan = result.pendingPlan;

        if (currentAssistantIndex !== null && activeModel) {
          const message = messages[currentAssistantIndex];
          if (message?.role === "assistant" && !message.model) {
            message.model = activeModel;
          }
        }

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

              if (lastUsage) {
                inputTokens = Number(lastUsage["input_tokens"] ?? 0);
                outputTokens = Number(lastUsage["output_tokens"] ?? 0);
                reasoningTokens = Number(lastUsage["reasoning_output_tokens"] ?? 0);
              } else if (cumulativeTotal > 0 && totalUsage) {
                inputTokens = Number(totalUsage["input_tokens"] ?? 0) - prevInput;
                outputTokens = Number(totalUsage["output_tokens"] ?? 0) - prevOutput;
                reasoningTokens =
                  Number(totalUsage["reasoning_output_tokens"] ?? 0) - prevReasoning;

                prevInput = Number(totalUsage["input_tokens"] ?? 0);
                prevOutput = Number(totalUsage["output_tokens"] ?? 0);
                prevReasoning = Number(totalUsage["reasoning_output_tokens"] ?? 0);
              }

              const totalInput = Math.max(0, inputTokens);
              if (totalInput || outputTokens || reasoningTokens) {
                totalInputTokens += totalInput;
                totalOutputTokens += outputTokens + reasoningTokens;

                // Bind to the most recent assistant message without tokens
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]!;
                  if (msg.role === "assistant" && !msg.tokens) {
                    msg.tokens = {
                      input: totalInput,
                      output: outputTokens + reasoningTokens,
                    };
                    break;
                  }
                }
              }
            }
          }
        }
      } catch {
        // skip malformed records
      }
    }

    // Finalize pending plan if any
    if (pendingPlan && currentAssistantIndex !== null) {
      messages[currentAssistantIndex]!.parts.push(pendingPlan);
    }

    return {
      id: meta.id,
      title: meta.title,
      slug: `codex/${meta.id}`,
      directory: meta.directory,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: {
        message_count: messages.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: 0,
      },
      messages,
    };
  }

  // ---- File listing ----

  private listRolloutFiles(): string[] {
    if (!this.basePath) return [];
    try {
      return this.walkDirForRolloutFiles(this.basePath);
    } catch {
      return [];
    }
  }

  private walkDirForRolloutFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.walkDirForRolloutFiles(fullPath));
        } else if (entry.endsWith(".jsonl") && entry.startsWith("rollout-")) {
          files.push(fullPath);
        }
      }
    } catch {
      // skip permission errors
    }
    return files;
  }

  // ---- Session index ----

  private loadSessionIndex(): void {
    if (this.sessionIndexCache.size > 0) return;

    const roots = resolveProviderRoots();
    const indexPath = join(roots.codexRoot, "session_index.jsonl");
    if (!existsSync(indexPath)) return;

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
    return this.sessionIndexCache.get(sessionId) ?? null;
  }

  // ---- Session head parsing ----

  private parseSessionHead(filePath: string): SessionHead | null {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    const sessionId = extractSessionId(filePath);

    let firstRecord: Record<string, unknown>;
    try {
      firstRecord = JSON.parse(lines[0]!);
    } catch {
      return null;
    }

    const payload = (firstRecord["payload"] ?? {}) as Record<string, unknown>;
    const createdAt = parseTimestampMs(payload) || statSync(filePath).mtimeMs;

    // Try title from session index
    const indexTitle = this.getTitleForSession(sessionId);
    // Fallback: extract from first user message
    const messageTitle = this.extractTitleFromLines(lines);
    const directoryTitle = basenameTitle(payload["cwd"] ? String(payload["cwd"]) : null);

    const title = resolveSessionTitle(indexTitle, messageTitle, directoryTitle);

    // Walk all lines to count messages, extract model, and pre-accumulate tokens
    let updatedAt = createdAt;
    let messageCount = 0;
    let model: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let scanPrevCumulativeTotal = 0;
    let scanPrevInput = 0;
    let scanPrevOutput = 0;
    let scanPrevReasoning = 0;

    const COUNTED_TYPES = new Set(["message", "function_call", "function_call_output"]);

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        if (recordType === "session_meta" || recordType === "turn_context") {
          const payload = (data["payload"] ?? {}) as Record<string, unknown>;
          if (!model) {
            model = extractModelName(payload["model"]);
          }
          const p = (data["payload"] ?? {}) as Record<string, unknown>;
          const ts = parseTimestampMs(p);
          if (ts > updatedAt) updatedAt = ts;
          continue;
        }

        if (recordType === "response_item") {
          const p = (data["payload"] ?? {}) as Record<string, unknown>;
          const pType = String(p["type"] ?? "");
          if (COUNTED_TYPES.has(pType)) {
            messageCount++;
          }
          // Extract model from response_item
          if (!model) {
            const info = p["info"] as Record<string, unknown> | undefined;
            const m = info?.["model"] ?? p["model"];
            if (typeof m === "string" && m.trim()) model = m.trim();
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

              if (lastUsage) {
                inputTokens = Number(lastUsage["input_tokens"] ?? 0);
                outputTokens = Number(lastUsage["output_tokens"] ?? 0);
                reasoningTokens = Number(lastUsage["reasoning_output_tokens"] ?? 0);
              } else if (cumulativeTotal > 0 && totalUsage) {
                inputTokens = Number(totalUsage["input_tokens"] ?? 0) - scanPrevInput;
                outputTokens = Number(totalUsage["output_tokens"] ?? 0) - scanPrevOutput;
                reasoningTokens =
                  Number(totalUsage["reasoning_output_tokens"] ?? 0) - scanPrevReasoning;

                scanPrevInput = Number(totalUsage["input_tokens"] ?? 0);
                scanPrevOutput = Number(totalUsage["output_tokens"] ?? 0);
                scanPrevReasoning = Number(totalUsage["reasoning_output_tokens"] ?? 0);
              }

              const totalInput = Math.max(0, inputTokens);
              totalInputTokens += totalInput;
              totalOutputTokens += outputTokens + reasoningTokens;
            }
          }
        }
      } catch {
        // skip
      }
    }

    const directory = payload["cwd"] ? String(payload["cwd"]) : "";

    return {
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
        total_cost: 0,
      },
    };
  }

  private extractTitleFromLines(lines: string[]): string | null {
    let userMessageCount = 0;
    for (const line of lines.slice(0, 20)) {
      try {
        const data = JSON.parse(line);
        const recordType = String(data["type"] ?? "");
        if (recordType !== "response_item") continue;

        const payload = (data["payload"] ?? {}) as Record<string, unknown>;
        const pType = String(payload["type"] ?? "");
        if (pType !== "message") continue;
        if (String(payload["role"] ?? "") !== "user") continue;

        // Skip the first user message (context injection); use the second
        userMessageCount++;
        if (userMessageCount < 2) continue;

        const content = payload["content"];
        if (Array.isArray(content)) {
          const texts = content
            .filter((item) => typeof item === "object" && item !== null && "text" in item)
            .map((item) => String((item as Record<string, unknown>)["text"] ?? ""))
            .join(" ");
          return normalizeTitleText(texts);
        }
        if (typeof content === "string") {
          return normalizeTitleText(content);
        }
      } catch {
        // skip
      }
    }
    return null;
  }

  // ---- Record conversion ----

  private convertRecord(
    data: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    sessionId: string,
    currentAssistantIndex: number | null,
    latestAssistantTextIndex: number | null,
    pendingPlan: MessagePart | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
    const recordType = String(data["type"] ?? "");

    // Skip non-response records
    if (recordType === "session_meta" || recordType === "event_msg") {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    if (recordType !== "response_item") {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    const payload = (data["payload"] ?? {}) as Record<string, unknown>;
    const payloadType = String(payload["type"] ?? "");
    const timestampMs = parseTimestampMs(data) || parseTimestampMs(payload);

    switch (payloadType) {
      case "message": {
        const role = String(payload["role"] ?? "");
        if (role === "assistant") {
          return this.convertAssistantMessage(
            payload,
            messages,
            timestampMs,
            currentAssistantIndex,
            latestAssistantTextIndex,
            pendingPlan,
          );
        }
        if (role === "user") {
          return this.convertUserMessage(
            payload,
            messages,
            timestampMs,
            currentAssistantIndex,
            latestAssistantTextIndex,
            pendingPlan,
          );
        }
        break;
      }

      case "reasoning":
        return this.convertReasoning(payload, messages, timestampMs, currentAssistantIndex);

      case "function_call":
        return this.convertFunctionCall(
          payload,
          messages,
          pendingToolCalls,
          timestampMs,
          currentAssistantIndex,
          latestAssistantTextIndex,
        );

      case "function_call_output":
        this.convertFunctionCallOutput(payload, messages, pendingToolCalls, timestampMs);
        return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };

      case "custom_tool_call":
        return this.convertCustomToolCall(
          payload,
          messages,
          pendingToolCalls,
          timestampMs,
          currentAssistantIndex,
          latestAssistantTextIndex,
        );

      case "custom_tool_call_output":
        this.convertCustomToolCallOutput(payload, messages, pendingToolCalls, timestampMs);
        return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
  }

  // ---- Assistant message ----

  private convertAssistantMessage(
    payload: Record<string, unknown>,
    messages: Message[],
    timestampMs: number,
    currentAssistantIndex: number | null,
    latestAssistantTextIndex: number | null,
    pendingPlan: MessagePart | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
    const content = payload["content"];
    if (!Array.isArray(content)) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    // Extract output_text items
    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const ci = item as Record<string, unknown>;
      if (String(ci["type"] ?? "") === "output_text") {
        const text = String(ci["text"] ?? "");
        if (text.trim()) textParts.push(text);
      }
    }

    if (textParts.length === 0) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    const fullText = textParts.join("\n");

    // Check for proposed plan
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

    // Build text part (strip the proposed plan tags)
    const displayText = fullText.replace(PROPOSED_PLAN_PATTERN, "").trim();
    if (!displayText) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    const textPart: MessagePart = { type: "text", text: displayText, time_created: timestampMs };

    // Append to current assistant or create new one
    if (currentAssistantIndex !== null) {
      const message = messages[currentAssistantIndex]!;
      const hasTool = message.parts.some((p) => p.type === "tool");
      if (!hasTool) {
        message.parts.push(textPart);
        latestAssistantTextIndex = currentAssistantIndex;
        return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
      }
    }

    messages.push(
      this.buildMessage({
        messageId: "",
        role: "assistant",
        timestampMs,
        parts: [textPart],
        agent: "codex",
      }),
    );
    currentAssistantIndex = messages.length - 1;
    latestAssistantTextIndex = currentAssistantIndex;

    return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
  }

  // ---- User message ----

  private convertUserMessage(
    payload: Record<string, unknown>,
    messages: Message[],
    timestampMs: number,
    currentAssistantIndex: number | null,
    latestAssistantTextIndex: number | null,
    pendingPlan: MessagePart | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
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

    if (!text.trim()) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    // Skip injected developer/system context messages
    if (isDeveloperLikeUserMessage(text)) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    // Check for plan approval
    if (text.trimStart().startsWith(PLAN_APPROVAL_PREFIX)) {
      // Finalize pending plan by attaching it to current assistant
      if (pendingPlan && currentAssistantIndex !== null) {
        messages[currentAssistantIndex]!.parts.push(pendingPlan);
      }
      pendingPlan = null;

      // The approval message itself is a user message
      messages.push(
        this.buildMessage({
          messageId: "",
          role: "user",
          timestampMs,
          parts: [{ type: "text", text: text.trim(), time_created: timestampMs }],
        }),
      );

      currentAssistantIndex = null;
      latestAssistantTextIndex = null;
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
    }

    // Check for subagent notification
    const subagentMatch = text.match(SUBAGENT_NOTIFICATION_PATTERN);
    if (subagentMatch) {
      try {
        const notifPayload = JSON.parse(subagentMatch[1]!) as Record<string, unknown>;
        const agentId = String(notifPayload["agent_id"] ?? "");
        const nickname = String(notifPayload["nickname"] ?? "");
        const completedText = String(notifPayload["completed"] ?? "");

        // Convert user message with subagent notification to assistant message
        const textPart: MessagePart = {
          type: "text",
          text: completedText || `Subagent ${nickname} completed`,
          time_created: timestampMs,
        };

        messages.push(
          this.buildMessage({
            messageId: "",
            role: "assistant",
            timestampMs,
            parts: [textPart],
            agent: "codex",
            subagent_id: agentId || undefined,
            nickname: nickname || undefined,
          }),
        );

        currentAssistantIndex = null;
        latestAssistantTextIndex = null;
        return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
      } catch {
        // Not valid JSON, treat as normal user message
      }
    }

    // Normal user message
    messages.push(
      this.buildMessage({
        messageId: "",
        role: "user",
        timestampMs,
        parts: [{ type: "text", text: text.trim(), time_created: timestampMs }],
      }),
    );

    currentAssistantIndex = null;
    latestAssistantTextIndex = null;
    return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan };
  }

  // ---- Reasoning ----

  private convertReasoning(
    payload: Record<string, unknown>,
    messages: Message[],
    timestampMs: number,
    currentAssistantIndex: number | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
    const summary = payload["summary"];
    if (!Array.isArray(summary)) {
      return { currentAssistantIndex, latestAssistantTextIndex: null, pendingPlan: null };
    }

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

    if (texts.length === 0) {
      return { currentAssistantIndex, latestAssistantTextIndex: null, pendingPlan: null };
    }

    const reasoningText = texts.join("\n");
    const part: MessagePart = { type: "reasoning", text: reasoningText, time_created: timestampMs };

    if (currentAssistantIndex !== null) {
      const message = messages[currentAssistantIndex]!;
      const hasText = message.parts.some((p) => p.type === "text");
      const hasTool = message.parts.some((p) => p.type === "tool");
      if (!hasText && !hasTool) {
        message.parts.push(part);
        return { currentAssistantIndex, latestAssistantTextIndex: null, pendingPlan: null };
      }
    }

    messages.push(
      this.buildMessage({
        messageId: "",
        role: "assistant",
        timestampMs,
        parts: [part],
        agent: "codex",
      }),
    );

    return {
      currentAssistantIndex: messages.length - 1,
      latestAssistantTextIndex: null,
      pendingPlan: null,
    };
  }

  // ---- Function call ----

  private convertFunctionCall(
    payload: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    timestampMs: number,
    currentAssistantIndex: number | null,
    latestAssistantTextIndex: number | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan: null };
    }

    const mappedName = mapToolTitle(name);
    const arguments_ = normalizeToolArguments(payload["arguments"]);

    const toolPart: MessagePart = {
      type: "tool",
      tool: mappedName,
      callID: callId,
      title: `Tool: ${mappedName}`,
      state: {
        arguments: arguments_,
        output: null,
      },
      time_created: timestampMs,
    };

    // Attach to latest assistant text message
    const targetIndex = latestAssistantTextIndex ?? currentAssistantIndex;
    if (targetIndex !== null) {
      const message = messages[targetIndex]!;
      const partIndex = message.parts.length;
      message.parts.push(toolPart);
      message.mode = "tool";
      if (callId) {
        pendingToolCalls.set(callId, [targetIndex, partIndex]);
      }
      return {
        currentAssistantIndex: targetIndex,
        latestAssistantTextIndex: targetIndex,
        pendingPlan: null,
      };
    }

    // Fallback: create new assistant message for tool
    messages.push(
      this.buildMessage({
        messageId: "",
        role: "assistant",
        timestampMs,
        parts: [toolPart],
        agent: "codex",
        mode: "tool",
      }),
    );
    const newIndex = messages.length - 1;
    if (callId) {
      pendingToolCalls.set(callId, [newIndex, 0]);
    }

    return { currentAssistantIndex: newIndex, latestAssistantTextIndex: null, pendingPlan: null };
  }

  // ---- Function call output ----

  private convertFunctionCallOutput(
    payload: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    timestampMs: number,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    if (!callId) return;

    const location = pendingToolCalls.get(callId);
    if (!location) return;

    const outputText = String(payload["output"] ?? "");
    const outputParts: MessagePart[] = outputText.trim()
      ? [{ type: "text", text: outputText, time_created: timestampMs }]
      : [];

    const [msgIndex, partIndex] = location;
    const state =
      messages[msgIndex]!.parts[partIndex]!.state ??
      (messages[msgIndex]!.parts[partIndex]!.state = {});

    if (outputParts.length > 0) {
      state.output = [...outputParts];
      state.status = "completed";
    }
  }

  // ---- Custom tool call ----

  private convertCustomToolCall(
    payload: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    timestampMs: number,
    currentAssistantIndex: number | null,
    latestAssistantTextIndex: number | null,
  ): {
    currentAssistantIndex: number | null;
    latestAssistantTextIndex: number | null;
    pendingPlan: MessagePart | null;
  } {
    const callId = String(payload["call_id"] ?? "").trim();
    const name = String(payload["name"] ?? "").trim();
    if (!name) {
      return { currentAssistantIndex, latestAssistantTextIndex, pendingPlan: null };
    }

    const mappedName = mapToolTitle(name);
    const rawInput = payload["input"];
    const normalizedInput = normalizeCustomToolArguments(name, rawInput);

    const toolPart: MessagePart = {
      type: "tool",
      tool: mappedName,
      callID: callId,
      title: `Tool: ${mappedName}`,
      state: {
        arguments: normalizedInput,
        output: null,
      },
      time_created: timestampMs,
    };

    // Attach to latest assistant text message
    const targetIndex = latestAssistantTextIndex ?? currentAssistantIndex;
    if (targetIndex !== null) {
      const message = messages[targetIndex]!;
      const partIndex = message.parts.length;
      message.parts.push(toolPart);
      message.mode = "tool";
      if (callId) {
        pendingToolCalls.set(callId, [targetIndex, partIndex]);
      }
      return {
        currentAssistantIndex: targetIndex,
        latestAssistantTextIndex: targetIndex,
        pendingPlan: null,
      };
    }

    // Fallback: create new assistant message
    messages.push(
      this.buildMessage({
        messageId: "",
        role: "assistant",
        timestampMs,
        parts: [toolPart],
        agent: "codex",
        mode: "tool",
      }),
    );
    const newIndex = messages.length - 1;
    if (callId) {
      pendingToolCalls.set(callId, [newIndex, 0]);
    }

    return { currentAssistantIndex: newIndex, latestAssistantTextIndex: null, pendingPlan: null };
  }

  // ---- Custom tool call output ----

  private convertCustomToolCallOutput(
    payload: Record<string, unknown>,
    messages: Message[],
    pendingToolCalls: Map<string, [number, number]>,
    timestampMs: number,
  ): void {
    const callId = String(payload["call_id"] ?? "").trim();
    if (!callId) return;

    const location = pendingToolCalls.get(callId);
    if (!location) return;

    const outputText = String(payload["output"] ?? "");
    const outputParts: MessagePart[] = outputText.trim()
      ? [{ type: "text", text: outputText, time_created: timestampMs }]
      : [];

    const [msgIndex, partIndex] = location;
    const state =
      messages[msgIndex]!.parts[partIndex]!.state ??
      (messages[msgIndex]!.parts[partIndex]!.state = {});

    if (outputParts.length > 0) {
      state.output = [...outputParts];
      state.status = "completed";
    }
  }

  // ---- Message builder ----

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
    subagent_id?: string;
    nickname?: string;
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
      subagent_id: opts.subagent_id,
      nickname: opts.nickname,
    };
  }
}
