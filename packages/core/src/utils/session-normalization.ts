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
  const next: MessagePart = { ...part };

  if (typeof next.text === "string") {
    next.text = cleanInternalText(next.text);
    if (!next.text && (next.type === "text" || next.type === "reasoning" || next.type === "plan")) {
      return null;
    }
  }

  if (typeof next.title === "string") {
    const title = cleanInternalText(next.title);
    if (title) next.title = title;
    else delete next.title;
  }

  if (next.input !== undefined) {
    next.input = cleanUnknown(next.input);
  }
  if (next.output !== undefined) {
    next.output = cleanUnknown(next.output);
  }
  if (next.state !== undefined) {
    next.state = cleanUnknown(next.state) as MessagePart["state"];
  }

  return next;
}

export function cleanMessageParts(parts: MessagePart[]): MessagePart[] {
  return parts.flatMap((part) => {
    const cleaned = cleanMessagePart(part);
    return cleaned ? [cleaned] : [];
  });
}

export function cleanParsedMessage(message: Message): Message | null {
  const parts = cleanMessageParts(message.parts);
  if (parts.length === 0) return null;
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
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const title = normalizeTitleText(cleanInternalText(part.text));
      if (title) return title;
    }
  }
  return null;
}
