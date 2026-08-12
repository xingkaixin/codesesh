/**
 * OpenCode tool display strategy — glob/grep/bash/read/edit/write/skill.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import { extractEditDiff } from "../diff";
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
  buildSkillToolStrategy,
} from "./shared";

export function buildOpencodeToolStrategy(
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
      title: tool.tool || "glob",
      pattern: toPlainText(input.pattern),
      baseDirectory,
    });
  }

  if (toolKey === "grep") {
    return buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: tool.tool || "grep",
      path: toPlainText(input.path),
      pattern: toPlainText(input.pattern),
      baseDirectory,
    });
  }

  if (toolKey === "bash") {
    return buildShellToolStrategy({
      defaultStrategy,
      state,
      title: tool.tool || "bash",
      command: toPlainText(input.command),
      description: toPlainText(input.description),
      baseDirectory,
    });
  }

  if (toolKey === "read") {
    return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath });
  }

  if (toolKey === "edit") {
    return buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      outputContent: {
        kind: "plain",
        text: extractEditDiff(state),
        language: "diff",
        isCode: true,
      },
    });
  }

  if (toolKey === "write") {
    return buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath });
  }

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy, baseDirectory);
  }

  return defaultStrategy;
}
