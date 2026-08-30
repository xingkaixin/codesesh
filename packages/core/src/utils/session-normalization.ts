import type { Message, MessagePart } from "../types/index.js";
import {
  cleanDisplayText,
  isInternalEventType as isRawInternalEventType,
} from "./parse-cleanup.js";
import { normalizeTitleText } from "./title-fallback.js";

export function isInternalEventType(value: unknown): boolean {
  return isRawInternalEventType(value);
}

export function cleanInternalText(text: string): string {
  return cleanDisplayText(text) ?? "";
}

function cleanUnknown(value: unknown): unknown {
  if (typeof value === "string") return cleanInternalText(value);
  if (Array.isArray(value)) return value.map(cleanUnknown);
  if (!value || typeof value !== "object") return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    cleaned[key] = cleanUnknown(child);
  }
  return cleaned;
}

export function cleanMessagePart(part: MessagePart): MessagePart | null {
  if (part.type === "text" || part.type === "reasoning" || part.type === "plan") {
    const text = cleanInternalText(part.text);
    return text ? { ...part, text } : null;
  }
  if (part.type !== "tool") return part;

  const title = part.title ? cleanInternalText(part.title) : "";
  const state = {
    ...part.state,
    ...(part.state.input !== undefined ? { input: cleanUnknown(part.state.input) } : {}),
    ...(part.state.output !== undefined ? { output: cleanUnknown(part.state.output) } : {}),
    ...(part.state.error !== undefined ? { error: cleanUnknown(part.state.error) } : {}),
    ...(part.state.metadata !== undefined ? { metadata: cleanUnknown(part.state.metadata) } : {}),
  };
  const { title: _title, ...withoutTitle } = part;
  return {
    ...withoutTitle,
    ...(title ? { title } : {}),
    state,
  };
}

export function cleanMessageParts(parts: MessagePart[]): MessagePart[] {
  return parts.flatMap((part) => {
    const cleaned = cleanMessagePart(part);
    return cleaned ? [cleaned] : [];
  });
}

export function cleanParsedMessage(message: Message): Message | null {
  const parts = cleanMessageParts(message.parts);
  const hasUsage =
    (message.cost ?? 0) > 0 || Object.values(message.tokens ?? {}).some((value) => value > 0);
  if (parts.length === 0 && !hasUsage) return null;
  return { ...message, parts };
}

export function cleanParsedMessages(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    const cleaned = cleanParsedMessage(message);
    return cleaned ? [cleaned] : [];
  });
}

export function firstUserMessageTitle(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const title = normalizeTitleText(cleanInternalText(part.text));
      if (title) return title;
    }
  }
  return null;
}
