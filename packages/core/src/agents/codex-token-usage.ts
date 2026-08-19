import type { MessageTokens, SessionStats } from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asRecord, narrowField } from "../utils/narrow.js";

export interface CodexTokenUsageDelta {
  tokens: MessageTokens;
  model: string | null;
  cost: number | null;
}

function usageRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  return narrowField("codex", field, value, asRecord);
}

function tokenCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function cachedInputTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return tokenCount(usage["cached_input_tokens"] ?? usage["cache_read_input_tokens"]);
}

export class CodexTokenUsageAccumulator {
  private previousCumulativeTotal = 0;
  private previousInput = 0;
  private previousOutput = 0;
  private previousReasoning = 0;
  private previousCachedInput = 0;
  private totalInput = 0;
  private totalOutput = 0;
  private totalCacheRead = 0;
  private totalCost = 0;
  private readonly tokensByModel: Record<string, number> = {};

  consume(payload: Record<string, unknown>, model: string | null): CodexTokenUsageDelta | null {
    const info = usageRecord(payload["info"], "token_count.info");
    const totalUsage = info
      ? usageRecord(info["total_token_usage"], "token_count.total_token_usage")
      : undefined;
    const lastUsage = info
      ? usageRecord(info["last_token_usage"], "token_count.last_token_usage")
      : undefined;
    const cumulativeTotal = tokenCount(totalUsage?.["total_tokens"]);
    const hasCumulativeTotal = cumulativeTotal > 0;

    if (hasCumulativeTotal && cumulativeTotal === this.previousCumulativeTotal) return null;

    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    if (lastUsage) {
      input = tokenCount(lastUsage["input_tokens"]);
      output = tokenCount(lastUsage["output_tokens"]);
      reasoning = tokenCount(lastUsage["reasoning_output_tokens"]);
      cacheRead = cachedInputTokens(lastUsage);
    } else if (totalUsage && hasCumulativeTotal) {
      input = tokenCount(totalUsage["input_tokens"]) - this.previousInput;
      output = tokenCount(totalUsage["output_tokens"]) - this.previousOutput;
      reasoning = tokenCount(totalUsage["reasoning_output_tokens"]) - this.previousReasoning;
      cacheRead = cachedInputTokens(totalUsage) - this.previousCachedInput;
    } else {
      return null;
    }

    if (totalUsage) {
      this.previousInput = tokenCount(totalUsage["input_tokens"]);
      this.previousOutput = tokenCount(totalUsage["output_tokens"]);
      this.previousReasoning = tokenCount(totalUsage["reasoning_output_tokens"]);
      this.previousCachedInput = cachedInputTokens(totalUsage);
    }
    if (hasCumulativeTotal) this.previousCumulativeTotal = cumulativeTotal;

    const normalizedInput = Math.max(0, input);
    const normalizedOutput = Math.max(0, output);
    const normalizedReasoning = Math.max(0, reasoning);
    const normalizedCacheRead = Math.max(0, cacheRead);
    if (
      normalizedInput === 0 &&
      normalizedOutput === 0 &&
      normalizedReasoning === 0 &&
      normalizedCacheRead === 0
    ) {
      return null;
    }

    const tokens: MessageTokens = {
      input: normalizedInput,
      output: normalizedOutput,
      reasoning: normalizedReasoning || undefined,
      cache_read: normalizedCacheRead || undefined,
    };
    const cost = estimateTokenCost(model, tokens);
    const modelTokens = normalizedInput + normalizedOutput + normalizedReasoning;
    if (model && modelTokens > 0) {
      this.tokensByModel[model] = (this.tokensByModel[model] ?? 0) + modelTokens;
    }
    this.totalInput += normalizedInput;
    this.totalOutput += normalizedOutput + normalizedReasoning;
    this.totalCacheRead += normalizedCacheRead;
    this.totalCost += cost ?? 0;

    return { tokens, model, cost };
  }

  stats(messageCount = 0): SessionStats {
    return {
      message_count: messageCount,
      total_input_tokens: this.totalInput,
      total_output_tokens: this.totalOutput,
      total_cache_read_tokens: this.totalCacheRead || undefined,
      total_cost: this.totalCost,
      cost_source: this.totalCost > 0 ? "estimated" : undefined,
    };
  }

  modelUsage(): Record<string, number> | undefined {
    return Object.keys(this.tokensByModel).length > 0 ? { ...this.tokensByModel } : undefined;
  }
}
