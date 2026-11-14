/**
 * Kimi tool display strategy.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "@codesesh/contract";
import { t } from "../../../i18n/translate";
import type { ToolDetailItem } from "../codex-tool";
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
import { buildZCodeToolStrategy } from "./zcode";

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

  if (toolKey === "readfile" || toolKey === "read") {
    return buildFileReadStrategy({
      defaultStrategy,
      state,
      filePath,
      displayPath,
      details: [
        typeof input.line_offset === "number"
          ? { label: t("Offset"), value: String(input.line_offset) }
          : null,
        typeof input.n_lines === "number"
          ? { label: t("Lines"), value: String(input.n_lines) }
          : null,
      ].filter((item): item is ToolDetailItem => item != null),
    });
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

  if (toolKey === "agent" || toolKey === "searchweb") {
    const strategy = buildZCodeToolStrategy(
      { ...tool, tool: toolKey === "searchweb" ? "websearch" : tool.tool, title: "" },
      state,
      baseDirectory,
    );
    return { ...strategy, showInputPreview: toolKey === "agent" };
  }

  return defaultStrategy;
}
