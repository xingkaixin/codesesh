/**
 * Kimi tool display strategy — glob/grep/shell/readFile/strReplaceFile/writeFile.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import { buildKimiEditDiffBlocks, extractEditDiff } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  toPlainText,
  toRecord,
} from "../tool-normalize";
import {
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildFileWriteStrategy,
  buildSearchToolStrategy,
  buildShellToolStrategy,
} from "./shared";

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
    return buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: tool.title || "glob",
      pattern: toPlainText(input.pattern),
      baseDirectory,
    });
  }

  if (toolKey === "grep") {
    return buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: tool.title || "grep",
      path: toPlainText(input.path),
      pattern: toPlainText(input.pattern),
      baseDirectory,
    });
  }

  if (toolKey === "shell") {
    return buildShellToolStrategy({
      defaultStrategy,
      state,
      title: tool.title || "bash",
      command: toPlainText(input.command),
      baseDirectory,
    });
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
