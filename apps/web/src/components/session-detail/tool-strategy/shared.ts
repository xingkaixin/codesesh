/**
 * Cross-agent tool-strategy infrastructure: state normalization, message
 * normalization, and the default/skill strategy builders + extractors reused
 * by 2+ agent builders (claudecode, opencode, kimi, pi, zcode).
 *
 * Pure logic — no React. Consumed by the per-agent builders in this folder.
 */
import type { Message, MessagePart } from "../../../lib/api";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStatus,
  compactText,
  extractCommand,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  joinToolText,
  normalizeEscapedNewlines,
  parseInputCandidate,
  toDisplayText,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { getDisplayTextWithRelativePaths } from "../path-extract";
import { SquareTerminal, Wrench } from "lucide-react";

export type { NormalizedToolState, ToolDisplayStrategy, ToolStatus };

export function stripClaudeReadNoise(text: string) {
  return text.replace(/\n*<system-reminder>[\s\S]*$/i, "").trimEnd();
}

export function extractReadContent(rawOutput: unknown) {
  const rawText = joinToolText(rawOutput, false) || formatToolOutput(rawOutput);
  if (rawText === "No output captured.") return rawText;

  const withoutWrapper = stripClaudeReadNoise(
    rawText.replace(/^<file>\s*/i, "").replace(/\s*<\/file>\s*$/i, ""),
  );
  const lines = withoutWrapper
    .split("\n")
    .filter((line) => !/^\(End of file - total \d+ lines\)$/.test(line.trim()))
    .map((line) => line.replace(/^\d+\|\s?/, "").replace(/^\s*\d+\t/, ""));
  const cleaned = lines.join("\n").trimEnd();
  return cleaned || "No output captured.";
}

export function extractWriteContent(state: NormalizedToolState) {
  const input = toRecord(state.inputValue);
  if (state.status === "completed") {
    const contentText = toStringValue(input.content);
    if (contentText.trim()) return normalizeEscapedNewlines(contentText);
  }
  return getOutputOrErrorText(state);
}

export function getAssistantDisplayLabel(msg: Message) {
  const nickname = compactText(msg.nickname);
  if (msg.role === "assistant" && nickname) return `AGENT (${nickname})`;
  if (msg.role === "user") return "USER";
  if (msg.role === "tool") return "TOOL";
  return "AGENT";
}

export function normalizeMessagesForDisplay(messages: Message[], sessionAgentKey: string) {
  if (sessionAgentKey.toLowerCase() !== "cursor") return messages;

  const normalized: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool") {
      normalized.push({ ...msg, parts: [...msg.parts] });
      continue;
    }
    const previous = normalized.at(-1);
    if (previous?.role === "assistant") {
      previous.parts.push(...msg.parts);
      continue;
    }
    normalized.push({ ...msg, parts: [...msg.parts] });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Tool state normalization
// ---------------------------------------------------------------------------

export function normalizeToolState(part: MessagePart): NormalizedToolState {
  const rawState = (part.state || {}) as Record<string, unknown>;
  const rawStatus = rawState.status;
  const status: ToolStatus =
    rawStatus === "running" || rawStatus === "error" || rawStatus === "completed"
      ? rawStatus
      : "completed";

  const outputValue = rawState.output ?? rawState.result ?? "";
  const errorValue = rawState.error ?? "";
  const inputValue = parseInputCandidate(rawState.input ?? rawState.arguments ?? {});
  const metadataValue = rawState.metadata ?? {};
  const command = extractCommand(inputValue);

  return {
    status,
    command,
    inputValue,
    outputValue,
    errorValue,
    metadataValue,
    inputText: toDisplayText(inputValue),
  };
}

// ---------------------------------------------------------------------------
// Tool display strategies
// ---------------------------------------------------------------------------

export function buildDefaultToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const preview = getDisplayTextWithRelativePaths(
    state.command || state.inputText || "{}",
    baseDirectory,
  );
  const compactPreview = preview.replace(/\s+/g, " ").trim();
  const previewText =
    compactPreview.length > 72 ? `${compactPreview.slice(0, 72)}...` : compactPreview;

  return {
    Icon: SquareTerminal,
    title: getToolTitle(tool),
    secondaryText: previewText ? `(${previewText})` : undefined,
    details: [],
    expandable: true,
    showInputPreview: true,
    outputContent: {
      kind: "plain",
      text: getOutputOrErrorText(state),
      language: "text",
      isCode: false,
    },
  };
}

export function buildSkillToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  defaultStrategy: ToolDisplayStrategy,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const input = toRecord(state.inputValue);
  const name = getDisplayTextWithRelativePaths(toPlainText(input.name), baseDirectory);

  return {
    ...defaultStrategy,
    Icon: Wrench,
    title: toPlainText(tool.tool) || "skill",
    secondaryText: name || undefined,
    expandable: false,
    showInputPreview: false,
  };
}
