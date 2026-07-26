/**
 * Kimi tool display strategy — glob/grep/shell/readFile/strReplaceFile/writeFile.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
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
import {
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildFileWriteStrategy,
} from "./shared";
import { FileSearch, SquareTerminal } from "../../ui/icons";

export function buildKimiToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = tool.tool.toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

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
    return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath });
  }

  if (toolKey === "strreplacefile") {
    const diffBlocks = buildKimiEditDiffBlocks(state, displayPath || filePath);
    return buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: extractEditDiff(state), language: "diff", isCode: true },
    });
  }

  if (toolKey === "writefile") {
    return buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath });
  }

  return defaultStrategy;
}
