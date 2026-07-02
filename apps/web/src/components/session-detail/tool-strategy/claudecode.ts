/**
 * Claude Code tool display strategy — read/edit/write rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { MessagePart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import { buildStructuredDiffFromTexts } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  getToolTitle,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { buildDefaultToolStrategy, extractReadContent, extractWriteContent } from "./shared";
import { BookOpenText, FilePenLine, NotebookPen } from "lucide-react";

export function buildClaudeToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "read") {
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: "read",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractReadContent(state.outputValue),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  if (toolKey === "edit") {
    const oldValue = toStringValue(input.old_string);
    const newValue = toStringValue(input.new_string);
    const diffBlocks = buildStructuredDiffFromTexts(displayPath || filePath, oldValue, newValue);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    };
  }

  if (toolKey === "write") {
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: "write",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
    };
  }

  return { ...defaultStrategy, title: getToolTitle(tool) };
}
