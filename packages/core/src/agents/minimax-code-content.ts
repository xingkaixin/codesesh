import type { CostSource, Message, MessagePart, MessageTokens, ToolPart } from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asNumber, asRecord, asString } from "../utils/narrow.js";
import type { DatabaseRow } from "../utils/sqlite.js";

export interface MiniMaxUsage {
  turnId?: string;
  model?: string;
  time: number;
  tokens: MessageTokens;
  total: number;
  cost: number;
  costSource?: CostSource;
}

function parseToolJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolPart(value: unknown): ToolPart | null {
  const call = asRecord(value);
  if (!call) return null;
  const tool = asString(call.tool_name);
  if (!tool) return null;
  const input = parseToolJson(call.tool_call_args);
  const output = parseToolJson(call.tool_call_result_data);
  const result = asRecord(output);
  const failed = call.tool_call_status === 3 || result?.isError === true || result?.error != null;
  return {
    type: "tool",
    tool,
    callID: asString(call.tool_call_id),
    state: {
      status: failed ? "error" : call.tool_call_status === 2 ? "completed" : "running",
      input,
      output,
      error: failed ? (result?.error ?? result?.text ?? output) : undefined,
      metadata: {
        ...asRecord(result?.details),
        minimax_status: call.tool_call_status,
      },
    },
  };
}

function attachmentPart(value: unknown): MessagePart | null {
  const attachment = asRecord(value);
  if (!attachment) return null;
  const path = asString(attachment.file_path) ?? asString(attachment.desktop_path);
  const mime = asString(attachment.mime_type);
  const name =
    path ??
    asString(attachment.file_name) ??
    asString(attachment.asset_id) ??
    asString(attachment.url);
  return name ? { type: "text", text: `Attachment: ${name}${mime ? ` (${mime})` : ""}` } : null;
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  compaction_start: "Context compaction started",
  compaction: "Context compacted",
  compaction_failed: "Context compaction failed",
  review_start: "Review started",
  review_result: "Review result",
  review_failed: "Review failed",
  review_aborted: "Review aborted",
  review_interrupted: "Review interrupted",
};

const AUTOMATED_SOURCES = new Set(["cron", "thread-goal", "team", "background-task", "system"]);

export function miniMaxMessage(row: DatabaseRow, agent: string): Message {
  const data = asRecord(JSON.parse(String(row.data_json)));
  const id = asString(row.msg_id);
  if (!data || !id || data.msg_id !== id) throw new Error("Invalid MiniMax display message");
  const role = row.role ?? data.role ?? "assistant";
  if (role !== "user" && role !== "assistant") throw new Error(`Invalid MiniMax role: ${role}`);
  const kind = asString(data.kind);
  const parts: MessagePart[] = [];
  if (kind) parts.push({ type: "text", text: EVENT_LABELS[kind] ?? `Event: ${kind}` });
  const thinking = asString(data.thinking_content);
  if (thinking) parts.push({ type: "reasoning", text: thinking });
  const text = asString(data.msg_content);
  if (text) parts.push({ type: "text", text });
  for (const value of Array.isArray(data.attachments) ? data.attachments : []) {
    const part = attachmentPart(value);
    if (part) parts.push(part);
  }
  const children = new Set<string>();
  for (const value of Array.isArray(data.tool_calls) ? data.tool_calls : []) {
    const part = toolPart(value);
    if (!part) continue;
    parts.push(part);
    if (part.tool === "task" || part.tool.startsWith("task_")) {
      const metadata = asRecord(part.state.metadata);
      const child = asString(metadata?.sub_session_id) ?? asString(metadata?.session_id);
      if (child) children.add(child);
    }
  }
  const error = asString(data.error);
  if (error) parts.push({ type: "text", text: error });
  const timestamp = asNumber(row.created_at_ms) ?? asNumber(data.timestamp) ?? 0;
  return {
    id,
    role,
    agent: role === "assistant" ? agent : undefined,
    time_created: timestamp,
    time_completed: data.finish_reason ? timestamp : undefined,
    mode: kind,
    automated:
      role === "user" && (Boolean(kind) || AUTOMATED_SOURCES.has(String(row.source)))
        ? true
        : undefined,
    subagent_id: children.size === 1 ? children.values().next().value : undefined,
    parts,
  };
}

function tokenCount(value: unknown): number {
  return Math.max(0, asNumber(value) ?? 0);
}

export function miniMaxUsage(row: DatabaseRow): MiniMaxUsage {
  const model = asString(row.model) || undefined;
  const tokens: MessageTokens = {
    input: tokenCount(row.input_tokens),
    output: tokenCount(row.output_tokens),
    reasoning: tokenCount(row.reasoning_tokens),
    cache_read: tokenCount(row.cache_read_tokens),
    cache_create: tokenCount(row.cache_write_tokens),
  };
  const recorded = asNumber(row.cost_usd);
  const cost =
    recorded !== undefined && recorded >= 0 ? recorded : estimateTokenCost(model, tokens);
  return {
    turnId: asString(row.turn_id),
    model,
    time: tokenCount(row.ts),
    tokens,
    total: Object.values(tokens).reduce((sum, value) => sum + value, 0),
    cost: cost ?? 0,
    costSource:
      recorded !== undefined && recorded >= 0
        ? "recorded"
        : cost !== null
          ? "estimated"
          : undefined,
  };
}

export function attachMiniMaxUsage(message: Message, usages: MiniMaxUsage[]): void {
  const models = new Set(usages.map((usage) => usage.model));
  if (models.size !== 1) return;
  message.model = usages[0]?.model;
  message.tokens = {};
  message.cost = 0;
  for (const usage of usages) {
    for (const key of ["input", "output", "reasoning", "cache_read", "cache_create"] as const) {
      message.tokens[key] = (message.tokens[key] ?? 0) + (usage.tokens[key] ?? 0);
    }
    message.cost += usage.cost;
    if (usage.costSource === "estimated" || !message.cost_source)
      message.cost_source = usage.costSource;
  }
}
