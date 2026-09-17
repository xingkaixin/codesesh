import type { MessagePart, MessageTokens } from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asArray, asNumber, asRecord, asString } from "../utils/narrow.js";
import type { DatabaseRow } from "../utils/sqlite.js";
import { TranscriptBuilder } from "./transcript-builder.js";

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(typeof value === "string" ? JSON.parse(value) : value);
}

function nonnegative(value: unknown): number {
  return Math.max(0, asNumber(value) ?? 0);
}

function tokensFromStats(stats: Record<string, unknown> | undefined): MessageTokens | undefined {
  if (!stats) return undefined;
  const input = asRecord(stats.inputTokenDetails);
  const output = asRecord(stats.outputTokenDetails);
  return {
    input:
      asNumber(stats.inputTokens) ??
      nonnegative(input?.noCacheTokens) +
        nonnegative(input?.cacheReadTokens) +
        nonnegative(input?.cacheWriteTokens),
    output:
      asNumber(stats.outputTokens) ??
      nonnegative(output?.textTokens) + nonnegative(output?.reasoningTokens),
    cache_read: nonnegative(input?.cacheReadTokens),
    cache_create: nonnegative(input?.cacheWriteTokens),
    reasoning: nonnegative(output?.reasoningTokens),
  };
}

function messageCost(
  stats: Record<string, unknown> | undefined,
  model: string | undefined,
  tokens: MessageTokens | undefined,
) {
  const costs = (asArray(stats?.costs) ?? []).flatMap((value) => {
    const cost = asRecord(value);
    return cost ? [cost] : [];
  });
  if (costs.length > 0 && costs.every((cost) => cost.currency === "USD")) {
    return {
      cost: costs.reduce((sum, cost) => sum + nonnegative(cost.amount), 0),
      costSource: costs.some((cost) => nonnegative(cost.computedRequestCount) > 0)
        ? ("estimated" as const)
        : ("recorded" as const),
    };
  }
  // Cherry's outputTokens already includes reasoning; do not price it twice.
  const cost = estimateTokenCost(model, tokens ? { ...tokens, reasoning: 0 } : undefined);
  return {
    cost: cost ?? undefined,
    costSource: cost === null ? undefined : ("estimated" as const),
  };
}

function convertPart(part: Record<string, unknown>): MessagePart | null {
  const type = asString(part.type);
  const text = asString(part.text);
  if ((type === "text" || type === "reasoning") && text) return { type, text };

  if (type === "dynamic-tool" || type?.startsWith("tool-")) {
    const state = asString(part.state);
    const failed = state === "output-error" || state === "output-denied";
    return {
      type: "tool",
      tool: asString(part.toolName) ?? (type === "dynamic-tool" ? "unknown" : type.slice(5)),
      callID: asString(part.toolCallId),
      title: asString(part.title),
      state: {
        status: failed ? "error" : state === "output-available" ? "completed" : "running",
        input: part.input,
        output: part.output,
        error: failed ? (part.errorText ?? "Tool execution failed") : undefined,
        metadata: part.providerMetadata,
      },
    };
  }

  if (type === "file") {
    const url = asString(part.url);
    const mime = asString(part.mediaType);
    if (url && mime?.startsWith("image/")) return { type: "image", url, mime_type: mime };
    const label = asString(part.filename) ?? url;
    return label ? { type: "text", text: `Attachment: ${label}` } : null;
  }

  const data = asRecord(part.data);
  if (type === "data-error") {
    const message = asString(data?.message);
    return message ? { type: "text", text: message } : null;
  }
  if (type === "data-compact" || type === "data-code" || type === "data-translation") {
    const content = asString(data?.content);
    return content ? { type: "text", text: content } : null;
  }
  return null;
}

export function cherryStudioTranscript(rows: readonly DatabaseRow[]) {
  const builder = new TranscriptBuilder();
  const modelUsage: Record<string, number> = Object.create(null);
  let totalTokens = 0;
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const data = jsonRecord(row.data);
    const snapshot = jsonRecord(row.message_snapshot);
    const modelSnapshot = asRecord(snapshot?.model);
    const uniqueModel = asString(row.model_id);
    const separator = uniqueModel?.indexOf("::") ?? -1;
    const model =
      asString(modelSnapshot?.id) ??
      (separator >= 0 ? uniqueModel?.slice(separator + 2) : uniqueModel);
    const provider =
      asString(modelSnapshot?.provider) ??
      (separator >= 0 ? uniqueModel?.slice(0, separator) : undefined);
    const stats = row.role === "assistant" ? jsonRecord(row.stats) : undefined;
    const tokens = tokensFromStats(stats);
    const total = nonnegative(stats?.totalTokens ?? (tokens?.input ?? 0) + (tokens?.output ?? 0));
    totalTokens += total;
    if (model && total > 0) modelUsage[model] = (modelUsage[model] ?? 0) + total;
    const message = builder.appendMessage({
      id: String(row.id),
      role: row.role,
      timestampMs: Number(row.created_at),
      agent: asString(snapshot?.name),
      model,
      provider,
      tokens,
      ...messageCost(stats, model, tokens),
      parts: (asArray(data?.parts) ?? []).flatMap((value) => {
        const part = asRecord(value);
        const converted = part ? convertPart(part) : null;
        return converted ? [converted] : [];
      }),
    });
    if (row.status !== "pending") message.time_completed = Number(row.updated_at);
  }
  const transcript = builder.finish();
  return {
    ...transcript,
    stats: { ...transcript.stats, total_tokens: totalTokens },
    modelUsage,
  };
}
