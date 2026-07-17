import type { Message, MessagePart, SessionStats } from "../types/index.js";
import { cleanParsedMessages } from "../utils/session-normalization.js";

export interface TranscriptMessageInput {
  id: string;
  role: Message["role"];
  timestampMs: number;
  parts?: MessagePart[];
  agent?: string | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  tokens?: Message["tokens"];
  cost?: number;
  costSource?: Message["cost_source"];
  subagentId?: string;
  nickname?: string;
}

export type AssistantMessageInput = Omit<TranscriptMessageInput, "role" | "parts">;

export interface ToolResolution {
  output?: unknown;
  status?: NonNullable<MessagePart["state"]>["status"];
  metadata?: unknown;
  consume?: boolean;
}

export interface TranscriptResult {
  messages: Message[];
  stats: SessionStats;
}

export class TranscriptBuilder {
  private readonly messages: Message[] = [];
  private readonly pendingToolCalls = new Map<string, MessagePart>();
  private currentAssistant: Message | null = null;
  private latestTextAssistant: Message | null = null;

  constructor(private readonly options: { messageDefaults?: "nullable" | "sparse" } = {}) {}

  beginTurn(): void {
    this.currentAssistant = null;
    this.latestTextAssistant = null;
  }

  appendMessage(input: TranscriptMessageInput): Message {
    const message = this.createMessage(input);
    this.messages.push(message);
    this.registerToolCalls(message.parts);

    if (message.role === "assistant") {
      this.currentAssistant = message;
      if (message.parts.some((part) => part.type === "text")) {
        this.latestTextAssistant = message;
      }
    } else if (message.role === "user") {
      this.beginTurn();
    }

    return message;
  }

  appendAssistantPart(
    part: MessagePart,
    input: AssistantMessageInput,
    options: {
      grouping?: "compatible" | "current";
      resetLatestText?: boolean;
      deduplicateTail?: boolean;
    } = {},
  ): Message {
    const current = this.currentAssistant;
    const canReuse =
      current !== null &&
      (options.grouping === "current" ||
        (part.type === "text"
          ? !current.parts.some((item) => item.type === "tool")
          : part.type === "reasoning"
            ? !current.parts.some((item) => item.type === "text" || item.type === "tool")
            : false));

    const message = canReuse
      ? current
      : this.appendMessage({ ...input, role: "assistant", parts: [part] });

    if (canReuse) {
      if (options.deduplicateTail) this.appendPartIfNew(message, part);
      else message.parts.push(part);
      this.applyMissingMetadata(message, input);
    }
    if (part.type === "text") {
      this.latestTextAssistant = message;
    } else if (options.resetLatestText) {
      this.latestTextAssistant = null;
    }
    return message;
  }

  appendToolCall(
    part: MessagePart,
    input: AssistantMessageInput,
    options: {
      markModeAsTool?: boolean;
      modeOnCreate?: string;
      target?: "latest-text" | "current";
    } = {},
  ): Message {
    const target =
      options.target === "current"
        ? this.currentAssistant
        : (this.latestTextAssistant ?? this.currentAssistant);
    const message = target
      ? target
      : this.appendMessage({
          ...input,
          role: "assistant",
          mode: options.modeOnCreate ?? (options.markModeAsTool ? "tool" : input.mode),
          parts: [part],
        });

    if (target) {
      message.parts.push(part);
      this.applyMissingMetadata(message, input);
      if (options.markModeAsTool) message.mode = "tool";
      this.registerToolCall(part);
    }

    this.currentAssistant = message;
    return message;
  }

  appendToCurrentAssistant(part: MessagePart): boolean {
    if (!this.currentAssistant) return false;
    this.currentAssistant.parts.push(part);
    return true;
  }

  updateToolCall(callId: string, update: (part: MessagePart) => void): boolean {
    const part = this.pendingToolCalls.get(callId);
    if (!part) return false;
    update(part);
    return true;
  }

  resolveToolCall(callId: string, resolution: ToolResolution): boolean {
    return this.updateToolCall(callId, (part) => {
      const state = part.state ?? (part.state = {});
      if (resolution.output !== undefined) state.output = resolution.output;
      if (resolution.status !== undefined) state.status = resolution.status;
      if (resolution.metadata !== undefined) state.metadata = resolution.metadata;
      if (resolution.consume) this.pendingToolCalls.delete(callId);
    });
  }

  attachUsageToLatestAssistant(
    tokens: Message["tokens"],
    options: { model?: string | null; cost?: number; costSource?: Message["cost_source"] } = {},
  ): boolean {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!;
      if (message.role !== "assistant" || message.tokens) continue;
      message.tokens = tokens;
      if (options.model !== undefined) message.model ??= options.model;
      if (options.cost !== undefined) message.cost = options.cost;
      if (options.costSource !== undefined) message.cost_source = options.costSource;
      return true;
    }
    return false;
  }

  finish(baseStats?: SessionStats): TranscriptResult {
    const messages = cleanParsedMessages(this.messages);
    const derived = this.deriveStats(messages);
    if (!baseStats) return { messages, stats: derived };

    return {
      messages,
      stats: {
        ...derived,
        ...baseStats,
        message_count: messages.length,
        cost_source: baseStats.cost_source,
      },
    };
  }

  private createMessage(input: TranscriptMessageInput): Message {
    const sparse = this.options.messageDefaults === "sparse";
    return {
      id: input.id,
      role: input.role,
      agent: sparse ? input.agent : (input.agent ?? null),
      time_created: input.timestampMs,
      mode: sparse ? input.mode : (input.mode ?? null),
      model: sparse ? input.model : (input.model ?? null),
      provider: sparse ? input.provider : (input.provider ?? null),
      tokens: input.tokens,
      cost: sparse ? input.cost : (input.cost ?? 0),
      cost_source: input.costSource,
      parts: input.parts ?? [],
      subagent_id: input.subagentId,
      nickname: input.nickname,
    };
  }

  private registerToolCalls(parts: MessagePart[]): void {
    for (const part of parts) this.registerToolCall(part);
  }

  private registerToolCall(part: MessagePart): void {
    if (part.type === "tool" && part.callID) {
      this.pendingToolCalls.set(part.callID, part);
    }
  }

  private appendPartIfNew(message: Message, part: MessagePart): void {
    const tail = message.parts.at(-1);
    if (tail?.type === part.type && tail.text === part.text) return;
    message.parts.push(part);
  }

  private applyMissingMetadata(message: Message, input: AssistantMessageInput): void {
    if (!message.id && input.id) message.id = input.id;
    if (message.agent == null && input.agent !== undefined) message.agent = input.agent;
    if (message.mode == null && input.mode !== undefined) message.mode = input.mode;
    if (message.model == null && input.model !== undefined) message.model = input.model;
    if (message.provider == null && input.provider !== undefined) message.provider = input.provider;
    if (!message.tokens && input.tokens) message.tokens = input.tokens;
    if ((message.cost ?? 0) === 0 && input.cost !== undefined) message.cost = input.cost;
    if (!message.cost_source && input.costSource) message.cost_source = input.costSource;
  }

  private deriveStats(messages: Message[]): SessionStats {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreateTokens = 0;
    let totalCost = 0;
    let hasEstimatedCost = false;

    for (const message of messages) {
      totalInputTokens += message.tokens?.input ?? 0;
      totalOutputTokens += message.tokens?.output ?? 0;
      totalCacheReadTokens += message.tokens?.cache_read ?? 0;
      totalCacheCreateTokens += message.tokens?.cache_create ?? 0;
      totalCost += message.cost ?? 0;
      if (message.cost_source === "estimated") hasEstimatedCost = true;
    }

    return {
      message_count: messages.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cache_read_tokens: totalCacheReadTokens || undefined,
      total_cache_create_tokens: totalCacheCreateTokens || undefined,
      total_cost: totalCost,
      cost_source: totalCost > 0 ? (hasEstimatedCost ? "estimated" : "recorded") : undefined,
    };
  }
}
