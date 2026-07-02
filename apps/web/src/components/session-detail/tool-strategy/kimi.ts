/**
 * Kimi tool display strategy — glob/grep/shell/readFile/strReplaceFile/writeFile.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { MessagePart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import { buildKimiEditDiffBlocks, extractEditDiff } from "../diff";
import {
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  toPlainText,
  toRecord,
} from "../tool-normalize";
import { buildDefaultToolStrategy, extractReadContent, extractWriteContent } from "./shared";
import { BookOpenText, FilePenLine, FileSearch, NotebookPen, SquareTerminal } from "lucide-react";

export function buildKimiToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);

  if (toolKey === "glob") {
    const pattern = toPlainText(input.pattern);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.title || "glob",
      secondaryText: pattern || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "grep") {
    const path = toPlainText(input.path);
    const pattern = toPlainText(input.pattern);
    const details = [getDisplayPath(path, baseDirectory), pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.title || "grep",
      secondaryText: details || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "shell") {
    const command = toPlainText(input.command);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: tool.title || "bash",
      secondaryText: displayCommand ? `(${displayCommand})` : undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "readfile") {
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: tool.title || "read",
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

  if (toolKey === "strreplacefile") {
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    const diffBlocks = buildKimiEditDiffBlocks(state, displayPath || filePath);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: tool.title || "edit",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: extractEditDiff(state), language: "diff", isCode: true },
    };
  }

  if (toolKey === "writefile") {
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: tool.title || "write",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: state.status === "completed",
      },
    };
  }

  return defaultStrategy;
}
