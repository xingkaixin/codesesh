import type { Message, MessagePart, ToolPart, ToolPartState } from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asArray, asNumber, asRecord, asString, reportFieldMismatch } from "../utils/narrow.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import { parseAgentTimestamp } from "../utils/timestamp.js";
import { TranscriptBuilder, type TranscriptMessageInput } from "./transcript-builder.js";

export interface ClaudeUsage {
  key: string;
  model: string | undefined;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export function parseClaudeTimestampMs(data: Record<string, unknown>): number {
  return parseAgentTimestamp(data["timestamp"], "claudecode") ?? 0;
}

/** Reads a numeric usage field; a present-but-wrong-typed field is a schema drift signal. */
function readUsageNumber(usage: Record<string, unknown>, field: string): number {
  const raw = usage[field];
  if (raw === undefined) return 0;
  const value = asNumber(raw);
  if (value === undefined) {
    reportFieldMismatch("claudecode", `message.usage.${field}`);
    return 0;
  }
  return value;
}

export function extractClaudeUsage(
  data: Record<string, unknown>,
  msg: Record<string, unknown>,
): ClaudeUsage | null {
  const rawUsage = msg["usage"];
  if (rawUsage === undefined || rawUsage === null) return null;

  const usage = asRecord(rawUsage);
  if (!usage) {
    reportFieldMismatch("claudecode", "message.usage");
    return null;
  }

  const requestId = typeof data["requestId"] === "string" ? data["requestId"].trim() : "";
  const uuid = typeof data["uuid"] === "string" ? data["uuid"].trim() : "";
  const key = requestId || uuid;
  if (!key) return null;

  return {
    key,
    model: asString(msg["model"])?.trim() || undefined,
    input: readUsageNumber(usage, "input_tokens"),
    output: readUsageNumber(usage, "output_tokens"),
    cacheRead: readUsageNumber(usage, "cache_read_input_tokens"),
    cacheCreate: readUsageNumber(usage, "cache_creation_input_tokens"),
  };
}

export class ClaudeRecordConverter {
  // --- Record conversion ---

  convertRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
    requestMessages: Map<string, Message>,
    childSessionIdByToolUseId: ReadonlyMap<string, string>,
  ): void {
    if (data["isMeta"] === true) return;

    const msgType = String(data["type"] ?? "");
    if (isInternalEventType(msgType)) return;

    if (msgType === "assistant") {
      this.convertAssistantRecord(
        data,
        builder,
        assistantUuidToToolCalls,
        requestMessages,
        childSessionIdByToolUseId,
      );
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
    requestMessages: Map<string, Message>,
    childSessionIdByToolUseId: ReadonlyMap<string, string>,
  ): void {
    const msg = asRecord(data["message"]) ?? {};
    const timestampMs = parseClaudeTimestampMs(data);
    const model = asString(msg["model"])?.trim();
    const rawContent = asArray(msg["content"]) ?? [];
    const uuid = String(data["uuid"] ?? "");
    const usage = extractClaudeUsage(data, msg);
    let usageMessage = usage ? requestMessages.get(usage.key) : undefined;
    // A distinct request must not inherit another request's model or usage.
    if (usage && !usageMessage) builder.beginTurn();

    const toolCallIds: string[] = [];
    for (const item of rawContent) {
      const part = asRecord(item);
      if (!part) continue;
      const partType = String(part["type"] ?? "");

      if (partType === "thinking") {
        const text = cleanInternalText(String(part["thinking"] ?? ""));
        if (text) {
          const message = builder.appendAssistantPart(
            this.buildReasoningPart(text, timestampMs),
            { id: uuid, timestampMs, agent: "claude", model },
            { deduplicateTail: true },
          );
          usageMessage ??= message;
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
              model,
            },
            { deduplicateTail: true },
          );
          usageMessage ??= message;
        }
        continue;
      }

      if (partType !== "tool_use") continue;

      const toolCallId = String(part["id"] ?? "").trim();
      const subagentId = childSessionIdByToolUseId.get(toolCallId);

      const toolPart = this.buildToolPart(part, timestampMs);
      const message = builder.appendToolCall(
        toolPart,
        { id: uuid, timestampMs, agent: "claude", subagentId, model },
        { modeOnCreate: "tool" },
      );
      if (subagentId) message.subagent_id = subagentId;
      usageMessage ??= message;
      if (toolCallId) {
        toolCallIds.push(toolCallId);
      }
    }

    if (toolCallIds.length > 0) {
      assistantUuidToToolCalls.set(uuid, toolCallIds);
    }
    if (usage) {
      usageMessage ??= builder.appendMessage({
        id: uuid,
        role: "assistant",
        timestampMs,
        agent: "claude",
        model,
      });
      requestMessages.set(usage.key, usageMessage);
      usageMessage.model = usage.model;
      usageMessage.tokens = {
        input: usage.input + usage.cacheCreate + usage.cacheRead,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_create: usage.cacheCreate,
      };
      usageMessage.time_completed = timestampMs;
      usageMessage.cost = estimateTokenCost(usage.model, usageMessage.tokens) ?? 0;
      usageMessage.cost_source = usageMessage.cost > 0 ? "estimated" : undefined;
    }
  }

  private convertUserRecord(
    data: Record<string, unknown>,
    builder: TranscriptBuilder,
    assistantUuidToToolCalls: Map<string, string[]>,
  ): void {
    const msg = asRecord(data["message"]) ?? {};
    const timestampMs = parseClaudeTimestampMs(data);
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
      const ci = asRecord(item);
      if (!ci || ci["type"] !== "tool_result") continue;

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
    const timestampMs = parseClaudeTimestampMs(data);
    const msg = asRecord(data["message"]) ?? {};
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

  private buildToolPart(part: Record<string, unknown>, timestampMs: number): ToolPart {
    const toolName = String(part["name"] ?? "");
    return {
      type: "tool",
      tool: toolName,
      callID: String(part["id"] ?? ""),
      title: `Tool: ${toolName}`,
      state: {
        status: "running",
        input: part["input"] ?? {},
        output: null,
      },
      time_created: timestampMs,
    };
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
      const ci = asRecord(item);
      if (ci) {
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
        const itemRecord = asRecord(item);
        if (itemRecord) {
          const rawSource = itemRecord["source"];
          if (itemRecord["type"] === "image" && rawSource) {
            const source = asRecord(rawSource);
            const data = asString(source?.["data"]) ?? "";
            const mimeType = asString(source?.["media_type"]) ?? "";
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
    stateUpdates?: Partial<Pick<ToolPartState, "status" | "metadata">>,
  ): boolean {
    if (!callId) return false;

    return builder.updateToolCall(callId, (part) => {
      const state = part.state;
      if (outputParts.length > 0) {
        const existing = state.output;
        if (Array.isArray(existing)) existing.push(...outputParts);
        else if (existing == null) state.output = [...outputParts];
        else state.output = [existing, ...outputParts];
      }
      if (stateUpdates?.status) state.status = stateUpdates.status;
      if (stateUpdates?.metadata !== undefined) state.metadata = stateUpdates.metadata;
      if (outputParts.length > 0 && state.status === "running") state.status = "completed";
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

  private extractToolStateUpdates(
    toolUseResult: unknown,
  ): Partial<Pick<ToolPartState, "status" | "metadata">> {
    const result = asRecord(toolUseResult);
    if (!result) return {};

    const updates: Partial<Pick<ToolPartState, "status" | "metadata">> = {};

    const success = result["success"];
    if (typeof success === "boolean") {
      updates.status = success ? "completed" : "error";
    }

    const commandName = result["commandName"];
    if (commandName) {
      updates.metadata = { commandName };
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
