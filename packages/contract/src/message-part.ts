import type {
  ImagePart,
  MessagePart,
  PlanPart,
  ToolPart,
  ToolPartState,
  ToolPartStatus,
} from "./session.js";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timeField(time_created: number | undefined) {
  return time_created === undefined ? {} : { time_created };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function normalizeStatus(
  state: Record<string, unknown>,
  output: unknown,
  error: unknown,
): ToolPartStatus {
  const status = state.status;
  if (status === "running" || status === "completed" || status === "error") return status;
  if (status === "success") return "completed";
  if (error != null) return "error";
  if (output !== undefined) return "completed";
  return "running";
}

function normalizeMetadata(state: Record<string, unknown>): unknown {
  const rawMetadata = state.metadata ?? state.meta;
  const extras = Object.fromEntries(
    Object.entries(state).filter(
      ([key]) =>
        !["status", "input", "arguments", "output", "result", "error", "metadata", "meta"].includes(
          key,
        ),
    ),
  );
  if (Object.keys(extras).length === 0) return rawMetadata;

  const metadata = toRecord(rawMetadata);
  return metadata ? { ...metadata, ...extras } : extras;
}

function normalizeToolState(value: unknown, legacyPart: Record<string, unknown>): ToolPartState {
  const state = toRecord(value) ?? {};
  const input = firstDefined(state.input, state.arguments, legacyPart.input);
  const output = firstDefined(state.output, state.result, legacyPart.output);
  const error = state.error;
  const metadata = normalizeMetadata(state);

  return {
    status: normalizeStatus(state, output, error),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function planText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = toRecord(value);
  if (!record) return "";
  return planText(record.text ?? record.plan ?? record.content);
}

function normalizePlanPart(
  value: Record<string, unknown>,
  time_created: number | undefined,
): PlanPart | null {
  const approval_status = value.approval_status === "fail" ? "fail" : "success";
  const text = planText(value.text ?? (approval_status === "fail" ? value.output : value.input));
  return text ? { type: "plan", text, approval_status, ...timeField(time_created) } : null;
}

function normalizeImagePart(
  value: Record<string, unknown>,
  time_created: number | undefined,
): ImagePart | null {
  const data = optionalString(value.data);
  const url = optionalString(value.url);
  const mime_type = optionalString(value.mime_type);

  if (data && mime_type) {
    return {
      type: "image",
      data,
      mime_type,
      ...(url ? { url } : {}),
      ...timeField(time_created),
    };
  }
  if (url) {
    return {
      type: "image",
      url,
      ...(data ? { data } : {}),
      ...(mime_type ? { mime_type } : {}),
      ...timeField(time_created),
    };
  }
  return null;
}

function normalizeToolPart(
  value: Record<string, unknown>,
  time_created: number | undefined,
): ToolPart | null {
  const title = optionalString(value.title);
  const callID = optionalString(value.callID);
  const tool = optionalString(value.tool)?.trim() || title?.replace(/^tool:\s*/i, "").trim();
  if (!tool) return null;

  return {
    type: "tool",
    tool,
    ...(title ? { title } : {}),
    ...(callID ? { callID } : {}),
    state: normalizeToolState(value.state, value),
    ...timeField(time_created),
  };
}

function normalizeMessagePart(value: unknown): MessagePart | null {
  const part = toRecord(value);
  if (!part) return null;
  const time_created = optionalTime(part.time_created);

  if (part.type === "text" || part.type === "reasoning") {
    if (typeof part.text !== "string") return null;
    return { type: part.type, text: part.text, ...timeField(time_created) };
  }
  if (part.type === "plan") return normalizePlanPart(part, time_created);
  if (part.type === "image") return normalizeImagePart(part, time_created);
  if (part.type === "tool") return normalizeToolPart(part, time_created);
  return null;
}

export function normalizeMessageParts(value: unknown): MessagePart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const normalized = normalizeMessagePart(part);
    return normalized ? [normalized] : [];
  });
}
