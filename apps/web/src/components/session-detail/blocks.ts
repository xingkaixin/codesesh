import type { MessagePart, PlanPart, ReasoningPart, TextPart, ToolPart } from "../../lib/api";

export type MessageBlockType = "reasoning" | "text" | "tool" | "plan";

export type MessageBlock =
  | { type: "reasoning"; parts: ReasoningPart[]; anchorIds?: string[] }
  | { type: "text"; parts: TextPart[]; anchorIds?: string[] }
  | { type: "tool"; parts: ToolPart[]; anchorIds?: string[] }
  | { type: "plan"; parts: PlanPart[]; anchorIds?: string[] };

export function buildMessageBlocks(parts: MessagePart[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  for (const part of parts) {
    if (part.type === "image") continue;
    if (part.type === "plan") {
      blocks.push({ type: "plan", parts: [part] });
      continue;
    }
    if (part.type !== "tool" && !part.text.trim()) continue;

    const previous = blocks.at(-1);
    if (part.type === "text") {
      if (previous?.type === "text") previous.parts.push(part);
      else blocks.push({ type: "text", parts: [part] });
      continue;
    }
    if (part.type === "reasoning") {
      if (previous?.type === "reasoning") previous.parts.push(part);
      else blocks.push({ type: "reasoning", parts: [part] });
      continue;
    }
    if (previous?.type === "tool") previous.parts.push(part);
    else blocks.push({ type: "tool", parts: [part] });
  }

  return blocks;
}
