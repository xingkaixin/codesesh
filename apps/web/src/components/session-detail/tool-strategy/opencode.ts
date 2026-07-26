/**
 * OpenCode tool display strategy — glob/grep/bash/read/edit/write/skill.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import { extractEditDiff } from "../diff";
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
  buildSkillToolStrategy,
} from "./shared";
import { FileSearch, SquareTerminal } from "../../ui/icons";

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
    const pattern = toPlainText(input.pattern);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: tool.tool || "glob",
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
      title: tool.tool || "grep",
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

  if (toolKey === "bash") {
    const description = toPlainText(input.description);
    const command = toPlainText(input.command);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    const secondaryText = description
      ? `${description}${displayCommand ? ` (${displayCommand})` : ""}`
      : displayCommand
        ? `(${displayCommand})`
        : undefined;
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: tool.tool || "bash",
      secondaryText,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
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
