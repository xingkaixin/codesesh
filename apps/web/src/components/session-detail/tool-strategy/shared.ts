/**
 * Cross-agent tool-strategy infrastructure: the default/skill strategy
 * builders and extractors reused by 2+ agent builders (claudecode, opencode,
 * kimi, pi, zcode).
 *
 * Pure logic — no React. Consumed by the per-agent builders in this folder.
 */
import type { MessagePart } from "../../../lib/api";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStatus,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  joinToolText,
  normalizeEscapedNewlines,
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
