import type { ThreadReadToolOutputContent } from "../tool-output/types";
import { toPlainText, toRecord } from "./tool-normalize";
import { parseJsonText } from "./utils";

function threadResult(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === "string") return threadResult(parseJsonText(value), depth + 1);
  const record = toRecord(value);
  if (typeof toRecord(record.thread).id === "string" && Array.isArray(record.turns)) return record;
  const content = Array.isArray(value) ? value : record.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const result = threadResult(toRecord(part).text, depth + 1);
    if (result) return result;
  }
  return null;
}

export function buildCodexReadThreadDisplay(
  input: unknown,
  output: unknown,
): ThreadReadToolOutputContent | null {
  const result = threadResult(output);
  if (!result) return null;
  const thread = toRecord(result.thread);
  const page = toRecord(result.page);
  return {
    kind: "thread-read",
    title: toPlainText(thread.title) || toPlainText(thread.id),
    threadId: toPlainText(thread.id),
    turns: (result.turns as unknown[]).map((value, index) => {
      const turn = toRecord(value);
      return {
        id: toPlainText(turn.id) || String(index),
        status: toPlainText(turn.status),
        startedAt: typeof turn.startedAt === "number" ? turn.startedAt : undefined,
        items: Array.isArray(turn.items) ? turn.items.map(toRecord) : [],
        error: turn.error ?? undefined,
      };
    }),
    hasMore: page.hasMore === true,
    newestFirst: page.order === "newest_first",
    request: Object.entries(toRecord(input)).map(([label, value]) => ({ label, value })),
    rawOutput: output,
  };
}
