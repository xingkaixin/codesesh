import { normalizeMessageParts } from "../contract/message-part.js";
import type { MessagePart, ToolPartState } from "../types/index.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { cleanInternalText } from "../utils/session-normalization.js";
import type { DatabaseRow } from "../utils/sqlite.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  narrowField,
  safeParseJsonRecord,
} from "../utils/narrow.js";

// ---------------------------------------------------------------------------
// Cursor data model interfaces
// ---------------------------------------------------------------------------

export interface ComposerData {
  id?: string;
  composerId?: string;
  text?: string;
  name?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  lastSendTime?: number;
  lastUpdatedAt?: number;
  model?: string;
  modelConfig?: { modelName?: string };
  inputTokenCount?: number;
  outputTokenCount?: number;
  subagentInfos?: SubagentInfo[];
  chatMessages?: ChatMessage[];
  usageData?: {
    contextTokensUsed?: number;
    contextTokenLimit?: number;
    contextUsagePercent?: number;
  };
}

export interface BubbleData {
  id?: string;
  composerId?: string;
  chatMessages?: ChatMessage[];
  type?: number; // 1 = user, 2 = assistant
  text?: string;
  requestId?: string;
  createdAt?: number;
  timestamp?: number;
  timingInfo?: {
    clientRpcSendTime?: number;
    clientSettleTime?: number;
    clientEndTime?: number;
  };
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  modelInfo?: {
    modelName?: string;
  };
  toolFormerData?: {
    name?: string;
    toolCallId?: string;
    status?: string;
    params?: unknown;
    result?: unknown;
    additionalData?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface SubagentInfo {
  id?: string;
  composerId?: string;
  title?: string;
  nickname?: string;
}

interface ChatMessage {
  role: string;
  text?: string;
  createdAt?: number;
  timestamp?: number;
  actions?: ActionEntry[];
  isCompletion?: boolean;
  [key: string]: unknown;
}

interface ActionEntry {
  type?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Safe parsing of external rows — cursorDiskKV values and workspace.json are
// untrusted (cross Cursor-version drift), so their fields are narrowed
// individually instead of blindly cast. A field that's absent behaves like
// today's optional-field fallback (?? 0 / skip); a field that's present but
// wrong-typed additionally reports once via diagnostics.
// ---------------------------------------------------------------------------

export function narrowString(field: string, value: unknown): string | undefined {
  return narrowField("cursor", field, value, asString);
}

function narrowNumber(field: string, value: unknown): number | undefined {
  return narrowField("cursor", field, value, asNumber);
}

function parseSubagentInfos(value: unknown): SubagentInfo[] | undefined {
  const arr = asArray(value);
  if (arr === undefined) return undefined;
  const infos: SubagentInfo[] = [];
  for (const item of arr) {
    const record = asRecord(item);
    if (!record) continue;
    infos.push({
      id: narrowString("subagentInfo.id", record.id),
      composerId: narrowString("subagentInfo.composerId", record.composerId),
      title: narrowString("subagentInfo.title", record.title),
      nickname: narrowString("subagentInfo.nickname", record.nickname),
    });
  }
  return infos;
}

function parseChatMessages(value: unknown): ChatMessage[] | undefined {
  const arr = asArray(value);
  if (arr === undefined) return undefined;
  const messages: ChatMessage[] = [];
  for (const item of arr) {
    const record = asRecord(item);
    if (!record) continue;
    const role = narrowString("chatMessage.role", record.role);
    if (role === undefined) continue;
    messages.push({ ...record, role, text: narrowString("chatMessage.text", record.text) });
  }
  return messages;
}

/** Parse a `composerData:*` row value into a field-validated ComposerData. */
export function parseComposerRow(value: string): ComposerData | null {
  const record = safeParseJsonRecord(value);
  if (!record) return null;

  const modelConfig = asRecord(record.modelConfig);

  return {
    id: narrowString("composer.id", record.id),
    composerId: narrowString("composer.composerId", record.composerId),
    text: narrowString("composer.text", record.text),
    name: narrowString("composer.name", record.name),
    title: narrowString("composer.title", record.title),
    createdAt: narrowNumber("composer.createdAt", record.createdAt),
    updatedAt: narrowNumber("composer.updatedAt", record.updatedAt),
    lastSendTime: narrowNumber("composer.lastSendTime", record.lastSendTime),
    lastUpdatedAt: narrowNumber("composer.lastUpdatedAt", record.lastUpdatedAt),
    model: narrowString("composer.model", record.model),
    modelConfig: modelConfig
      ? { modelName: narrowString("composer.modelConfig.modelName", modelConfig.modelName) }
      : undefined,
    inputTokenCount: narrowNumber("composer.inputTokenCount", record.inputTokenCount),
    outputTokenCount: narrowNumber("composer.outputTokenCount", record.outputTokenCount),
    subagentInfos: parseSubagentInfos(record.subagentInfos),
    chatMessages: parseChatMessages(record.chatMessages),
  };
}

export interface BubbleRow extends DatabaseRow {
  row_id: number;
  key: string;
  value: string;
}

interface BubbleEntry {
  rowId: number;
  key: string;
  bubble: BubbleData;
}

/**
 * One composer's bubbles, parsed once and offered in both orders the readers
 * need: request ids come from the key-ordered view, messages from insertion
 * order.
 */
export interface ComposerBubbles {
  composerId: string;
  byKey: BubbleEntry[];
  byRowId: BubbleEntry[];
}

/** A composer waiting for its bubbles in the second phase of a scan. */
export interface PendingComposer {
  composer: ComposerData;
  composerId: string;
  createdAt: number;
  updatedAt: number;
  hasSubagents: boolean;
  order: number;
}

export function composerIdFromBubbleKey(key: string): string {
  const start = key.indexOf(":") + 1;
  const end = key.indexOf(":", start);
  return end === -1 ? key.slice(start) : key.slice(start, end);
}

export function groupBubbleRows(rows: BubbleRow[]): ComposerBubbles {
  const byKey: BubbleEntry[] = [];
  for (const row of rows) {
    const bubble = parseBubbleRow(row.value);
    if (bubble) byKey.push({ rowId: row.row_id, key: row.key, bubble });
  }
  byKey.sort((left, right) => left.key.localeCompare(right.key));
  return {
    composerId: rows.length > 0 ? composerIdFromBubbleKey(rows[0]!.key) : "",
    byKey,
    byRowId: [...byKey].sort((left, right) => left.rowId - right.rowId),
  };
}

/** Parse a `bubbleId:*` / `bubble:*` row value into a field-validated BubbleData. */
export function parseBubbleRow(value: string): BubbleData | null {
  const record = safeParseJsonRecord(value);
  if (!record) return null;

  const timingInfo = asRecord(record.timingInfo);
  const tokenCount = asRecord(record.tokenCount);
  const modelInfo = asRecord(record.modelInfo);
  const toolFormerData = asRecord(record.toolFormerData);

  return {
    ...record,
    id: narrowString("bubble.id", record.id),
    composerId: narrowString("bubble.composerId", record.composerId),
    chatMessages: parseChatMessages(record.chatMessages),
    type: narrowNumber("bubble.type", record.type),
    text: narrowString("bubble.text", record.text),
    requestId: narrowString("bubble.requestId", record.requestId),
    createdAt: narrowNumber("bubble.createdAt", record.createdAt),
    timestamp: narrowNumber("bubble.timestamp", record.timestamp),
    timingInfo: timingInfo
      ? {
          clientRpcSendTime: narrowNumber(
            "bubble.timingInfo.clientRpcSendTime",
            timingInfo.clientRpcSendTime,
          ),
          clientSettleTime: narrowNumber(
            "bubble.timingInfo.clientSettleTime",
            timingInfo.clientSettleTime,
          ),
          clientEndTime: narrowNumber("bubble.timingInfo.clientEndTime", timingInfo.clientEndTime),
        }
      : undefined,
    tokenCount: tokenCount
      ? {
          inputTokens: narrowNumber("bubble.tokenCount.inputTokens", tokenCount.inputTokens),
          outputTokens: narrowNumber("bubble.tokenCount.outputTokens", tokenCount.outputTokens),
        }
      : undefined,
    modelInfo: modelInfo
      ? { modelName: narrowString("bubble.modelInfo.modelName", modelInfo.modelName) }
      : undefined,
    toolFormerData: toolFormerData
      ? {
          name: narrowString("bubble.toolFormerData.name", toolFormerData.name),
          toolCallId: narrowString("bubble.toolFormerData.toolCallId", toolFormerData.toolCallId),
          status: narrowString("bubble.toolFormerData.status", toolFormerData.status),
          params: toolFormerData.params,
          result: toolFormerData.result,
          additionalData: asRecord(toolFormerData.additionalData),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CURSOR_TOOL_TITLE_MAP: Record<string, string> = {
  read_file_v2: "read",
  edit_file_v2: "edit",
  run_terminal_command_v2: "bash",
  ripgrep_raw_search: "grep",
  glob_file_search: "glob",
};

export function mapToolTitle(toolName: string): string {
  return CURSOR_TOOL_TITLE_MAP[toolName] ?? toolName;
}

/** Normalize tool output into MessagePart[] */
function normalizeToolOutputParts(output: unknown, timestampMs: number): MessagePart[] {
  if (output == null) return [];

  if (typeof output === "string") {
    const text = cleanInternalText(output);
    return text ? [{ type: "text" as const, text, time_created: timestampMs }] : [];
  }

  if (Array.isArray(output)) {
    const parts: MessagePart[] = [];
    for (const item of output) {
      if (typeof item === "object" && item !== null) {
        const record = asRecord(item);
        const text = String(record?.text ?? record?.content ?? "");
        const cleaned = cleanInternalText(text);
        if (cleaned) parts.push({ type: "text", text: cleaned, time_created: timestampMs });
      } else if (typeof item === "string") {
        const text = cleanInternalText(item);
        if (text) parts.push({ type: "text", text, time_created: timestampMs });
      }
    }
    return parts;
  }

  // For object output, stringify for readability
  const text = cleanInternalText(String(output));
  return text ? [{ type: "text", text, time_created: timestampMs }] : [];
}

/** Extract a timestamp (in ms) from a chat message */
export function extractTimestamp(msg: ChatMessage): number {
  if (msg.createdAt && typeof msg.createdAt === "number" && msg.createdAt > 0) {
    return msg.createdAt;
  }
  if (msg.timestamp && typeof msg.timestamp === "number" && msg.timestamp > 0) {
    return msg.timestamp;
  }
  return 0;
}

export function isInternalBubble(bubble: BubbleData): boolean {
  return ["eventType", "kind", "subtype", "name"].some((key) => isInternalEventType(bubble[key]));
}

export function composerUpdatedAt(composer: ComposerData): number {
  return (
    composer.updatedAt ?? composer.lastUpdatedAt ?? composer.lastSendTime ?? composer.createdAt ?? 0
  );
}

export function cursorToolStatus(status: string | undefined): ToolPartState["status"] {
  if (status === "completed") return "completed";
  if (status === "error" || status === "failed") return "error";
  return "running";
}

/** Build a normalized tool state object from an action entry */
function buildToolState(action: ActionEntry): ToolPartState {
  let output = action.output;
  if (action.output != null) {
    const ts = 0; // we don't have a finer-grained timestamp for the output
    const outputParts = normalizeToolOutputParts(action.output, ts);
    output = outputParts.length > 0 ? outputParts : action.output;
  }

  const [part] = normalizeMessageParts([
    {
      type: "tool",
      tool: action.tool ?? "unknown",
      input: action.input,
      output,
      state: action.state,
    },
  ]);
  return part?.type === "tool" ? part.state : { status: "running" };
}

/** Build a MessagePart for a tool action */
function buildToolPart(action: ActionEntry, timestampMs: number): MessagePart {
  const toolName = action.tool ?? "unknown";
  return {
    type: "tool",
    tool: mapToolTitle(toolName),
    callID: action.type ? `${action.type}:${String(action.input?.id ?? "")}` : "",
    title: `Tool: ${mapToolTitle(toolName)}`,
    state: buildToolState(action),
    time_created: timestampMs,
  };
}

/** Build a MessagePart for terminal command actions */
function buildTerminalToolPart(action: ActionEntry, timestampMs: number): MessagePart {
  const command = String(action.input?.command ?? "");
  const description = cleanInternalText(String(action.input?.commandDescription ?? ""));

  const state = buildToolState(action);
  state.input = { command };
  state.output =
    typeof action.output === "string"
      ? [{ type: "text" as const, text: action.output, time_created: timestampMs }]
      : normalizeToolOutputParts(action.output, timestampMs);

  return {
    type: "tool",
    tool: "bash",
    callID: "",
    title: description || `bash: ${command.slice(0, 60)}`,
    state,
    time_created: timestampMs,
  };
}

/** Convert an ActionEntry into a MessagePart */
export function convertActionToPart(action: ActionEntry, timestampMs: number): MessagePart | null {
  const toolName = action.tool ?? "";

  // Terminal commands get special handling
  if (toolName === "run_terminal_command_v2") {
    return buildTerminalToolPart(action, timestampMs);
  }

  // Generic tool call
  if (toolName && action.type === "tool") {
    return buildToolPart(action, timestampMs);
  }

  return null;
}
