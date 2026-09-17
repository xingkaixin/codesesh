import type { MessagePart, MessageTokens } from "../types/index.js";
import { asArray, asNumber, asRecord, asString } from "../utils/narrow.js";

export function parseDeepChatJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function deepChatTokens(metadata: Record<string, unknown>): MessageTokens | undefined {
  const input = asNumber(metadata.inputTokens);
  const output = asNumber(metadata.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = Math.max(0, asNumber(metadata.cachedInputTokens) ?? 0);
  const cacheCreate = Math.max(0, asNumber(metadata.cacheWriteInputTokens) ?? 0);
  return {
    input: Math.max(0, input ?? 0),
    output: Math.max(0, output ?? 0),
    cache_read: Math.min(cacheRead, Math.max(0, input ?? 0)),
    cache_create: Math.min(cacheCreate, Math.max(0, (input ?? 0) - cacheRead)),
  };
}

export function deepChatAssistantPart(block: Record<string, unknown>): MessagePart | null {
  const time_created = asNumber(block.timestamp);
  const content = asString(block.content);
  if (block.type === "tool_call") {
    const tool = asRecord(block.tool_call);
    if (!tool) return null;
    const status =
      block.status === "pending" || block.status === "loading"
        ? "running"
        : block.status === "error" || block.status === "denied"
          ? "error"
          : "completed";
    const output = parseDeepChatJson(tool.response);
    return {
      type: "tool",
      tool: asString(tool.name) ?? "unknown",
      callID: asString(tool.id),
      time_created,
      state: {
        status,
        input: parseDeepChatJson(tool.params),
        output,
        error: status === "error" ? (output ?? content) : undefined,
        metadata: asRecord(block.extra),
      },
    };
  }
  if (block.type === "image") {
    const image = asRecord(block.image_data);
    const data = asString(image?.data);
    const mime = asString(image?.mimeType);
    if (data && mime) return { type: "image", data, mime_type: mime, time_created };
  }
  if (!content) return null;
  return {
    type: block.type === "reasoning_content" ? "reasoning" : "text",
    text: content,
    time_created,
  };
}

export function deepChatStoredBlockPart(row: Record<string, unknown>): MessagePart | null {
  const extra = asRecord(parseDeepChatJson(row.extra_json));
  return deepChatAssistantPart({
    type: row.block_type,
    content: row.text_content,
    status: row.status,
    timestamp: extra?.timestamp ?? row.updated_at,
    extra: extra?.extra,
    tool_call: {
      id: row.tool_call_id,
      name: row.tool_name,
      params: row.tool_params,
      response: row.tool_response,
    },
    image_data: { data: extra?.imageData, mimeType: row.image_mime_type },
  });
}

export function deepChatUserParts(content: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = [];
  const text = asString(content.text);
  if (text) parts.push({ type: "text", text });
  for (const file of asArray(content.files) ?? []) {
    const record = asRecord(file);
    const path = asString(record?.path);
    const name = asString(record?.name);
    if (path || name) parts.push({ type: "text", text: `Attachment: ${path ?? name}` });
  }
  for (const link of asArray(content.links) ?? []) {
    if (typeof link === "string") parts.push({ type: "text", text: link });
  }
  return parts;
}

export function deepChatRawParts(role: string, content: string): MessagePart[] {
  const parsed = parseDeepChatJson(content);
  if (role === "user") {
    const user = asRecord(parsed);
    if (user) return deepChatUserParts(user);
  }
  if (Array.isArray(parsed)) {
    const parts: MessagePart[] = [];
    for (const value of parsed) {
      const block = asRecord(value);
      const part = block ? deepChatAssistantPart(block) : null;
      if (part) parts.push(part);
    }
    return parts;
  }
  return typeof parsed === "string" && parsed ? [{ type: "text", text: parsed }] : [];
}
