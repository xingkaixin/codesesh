import type { MessagePart } from "../../lib/api";

export type MessageBlockType = "reasoning" | "text" | "tool" | "plan";

export interface MessageBlock {
  type: MessageBlockType;
  parts: MessagePart[];
}

export function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const r = item as Record<string, unknown>;
          const t = extractMessageText(r.text);
          if (t.trim()) return t;
          const c = extractMessageText(r.content);
          if (c.trim()) return c;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    const t = extractMessageText(r.text);
    if (t.trim()) return t;
    const c = extractMessageText(r.content);
    if (c.trim()) return c;
  }

  return "";
}

function isVisiblePart(part: MessagePart) {
  if (part.type === "tool" || part.type === "plan") return true;
  if (part.type === "text" || part.type === "reasoning") {
    return Boolean(extractMessageText(part.text).trim());
  }
  return false;
}

export function buildMessageBlocks(parts: MessagePart[]): MessageBlock[] {
  return parts.reduce<MessageBlock[]>((blocks, part) => {
    if (part.type === "image") return blocks;
    if (!isVisiblePart(part)) return blocks;

    const prev = blocks.at(-1);
    if (part.type !== "plan" && prev?.type === part.type) {
      prev.parts.push(part);
      return blocks;
    }

    blocks.push({ type: part.type, parts: [part] });
    return blocks;
  }, []);
}
