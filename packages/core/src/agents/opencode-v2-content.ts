import type { Message, MessagePart, MessageTokens, ToolPart } from "../types/index.js";
import { asArray, asNumber, asRecord, asString } from "../utils/narrow.js";
import { cleanParsedMessage } from "../utils/session-normalization.js";

function textPart(text: string): MessagePart {
  return { type: "text", text };
}

function describe(value: unknown): string {
  return asString(value) ?? JSON.stringify(value, null, 2) ?? "";
}

function attachments(value: unknown): MessagePart[] {
  return (asArray(value) ?? []).map((value) => {
    const file = asRecord(value) ?? {};
    const mime = asString(file.mime);
    const data = asString(file.data);
    if (mime?.startsWith("image/") && data) return { type: "image", data, mime_type: mime };
    const source = asRecord(file.source);
    return textPart(
      `[Attachment] ${[file.name, mime, file.uri ?? source?.uri].filter(Boolean).join(" · ")}`,
    );
  });
}

function toolOutput(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((value) => {
      const content = asRecord(value);
      if (content?.type === "text") return asString(content.text) ?? "";
      if (content?.type === "file")
        return `[Attachment] ${[content.name, content.mime, content.uri].filter(Boolean).join(" · ")}`;
      return describe(value);
    })
    .join("\n\n");
}

function assistantContent(value: unknown): MessagePart {
  const content = asRecord(value) ?? {};
  if (content.type === "text" || content.type === "reasoning") {
    return { type: content.type, text: asString(content.text) ?? "" };
  }
  if (content.type !== "tool" || !asString(content.name))
    return textPart(`[Unknown content] ${describe(value)}`);

  const state = asRecord(content.state) ?? {};
  const time = asRecord(content.time);
  return {
    type: "tool",
    tool: String(content.name),
    callID: asString(content.id),
    time_created: asNumber(time?.created),
    state: {
      status: state.status === "completed" || state.status === "error" ? state.status : "running",
      input: state.input,
      output: toolOutput(state.content),
      error: state.error,
      metadata: state.metadata,
    },
  };
}

function tokens(value: unknown): MessageTokens | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cache = asRecord(usage.cache);
  return {
    input: asNumber(usage.input),
    output: asNumber(usage.output),
    reasoning: asNumber(usage.reasoning),
    cache_read: asNumber(cache?.read),
    cache_create: asNumber(cache?.write),
  };
}

export function openCodeV2Message(row: Record<string, unknown>): Message | null {
  const data = asRecord(JSON.parse(String(row.data)));
  if (!data) throw new Error(`Invalid OpenCode V2 message: ${String(row.id)}`);
  const type = String(row.type);
  if (type === "idle") return null;
  const time = asRecord(data.time);
  const model = asRecord(data.model);
  const message: Message = {
    id: String(row.id),
    role:
      type === "user" || type === "synthetic" || type === "system" || type === "skill"
        ? "user"
        : "assistant",
    agent: asString(data.agent),
    model: asString(model?.id),
    provider: asString(model?.providerID),
    time_created: Number(row.time_created),
    time_completed: asNumber(time?.completed),
    mode: type === "user" || type === "assistant" ? undefined : type,
    automated: type === "synthetic" || type === "system" || type === "skill" ? true : undefined,
    tokens: tokens(data.tokens),
    cost: asNumber(data.cost),
    cost_source: asNumber(data.cost) === undefined ? undefined : "recorded",
    parts: [],
  };

  if (type === "user") {
    message.parts.push(textPart(asString(data.text) ?? ""), ...attachments(data.files));
    for (const mention of [...(asArray(data.agents) ?? []), ...(asArray(data.skills) ?? [])]) {
      const name = asString(asRecord(mention)?.name);
      if (name) message.parts.push(textPart(`@${name}`));
    }
  } else if (type === "assistant") {
    if (!Array.isArray(data.content)) throw new Error(`Invalid OpenCode V2 content: ${message.id}`);
    message.parts = data.content.map(assistantContent);
    const children = new Set<string>();
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "subagent") continue;
      const child = asString(asRecord(part.state.metadata)?.sessionID);
      if (child) children.add(child);
    }
    if (children.size === 1) message.subagent_id = [...children][0];
  } else if (type === "shell") {
    const output = asRecord(data.output);
    const status =
      data.status === "running"
        ? "running"
        : data.status === "exited" && (data.exit == null || data.exit === 0)
          ? "completed"
          : "error";
    const part: ToolPart = {
      type: "tool",
      tool: "shell",
      callID: asString(data.shellID),
      state: {
        status,
        input: { command: data.command },
        output: asString(output?.output),
        error:
          status === "error"
            ? `Shell ${String(data.status)} (exit: ${String(data.exit ?? "unknown")})`
            : undefined,
        metadata: { shellID: data.shellID, exit: data.exit, ...output },
      },
    };
    message.parts.push(part);
  } else if (type === "compaction") {
    message.parts.push(
      textPart(
        [`[Compaction: ${String(data.status)}]`, data.summary, data.recent]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  } else if (type === "synthetic" || type === "system" || type === "skill") {
    message.parts.push(
      textPart(`[${type}] ${asString(data.description) ?? asString(data.name) ?? ""}`),
    );
    message.parts.push(textPart(asString(data.text) ?? ""));
  } else {
    message.parts.push(textPart(`[${type}] ${describe(data)}`));
  }
  if (data.error != null) message.parts.push(textPart(`[Error] ${describe(data.error)}`));
  return cleanParsedMessage(message);
}
