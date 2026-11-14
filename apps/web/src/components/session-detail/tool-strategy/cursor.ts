import { t } from "../../../i18n/translate";
/**
 * Cursor tool display strategy — read/edit/grep/glob/bash rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "@codesesh/contract";
import {
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { parseJsonText } from "../utils";
import { buildDefaultToolStrategy, buildFileEditStrategy, buildFileReadStrategy } from "./shared";
import { FileSearch, SquareTerminal } from "../../ui/icons";

export function getCursorOutputRecord(rawOutput: unknown) {
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    return rawOutput as Record<string, unknown>;
  }
  if (typeof rawOutput === "string") {
    return parseJsonText<Record<string, unknown>>(rawOutput) || {};
  }
  return {};
}

export function extractCursorReadContent(rawOutput: unknown) {
  const output = getCursorOutputRecord(rawOutput);
  const contents = toStringValue(output.contents);
  if (contents) return contents;
  return t("No output captured.");
}

export function formatCursorSearchOutput(rawOutput: unknown) {
  const output = getCursorOutputRecord(rawOutput);
  const directories = Array.isArray(output.directories) ? output.directories : [];
  if (directories.length === 0) return formatToolOutput(rawOutput);

  const lines = directories.flatMap((entry) => {
    const record = toRecord(entry);
    const directoryPath = toPlainText(record.absPath);
    const files = Array.isArray(record.files) ? record.files : [];
    const fileLines = files
      .map((file) => {
        const fileRecord = toRecord(file);
        return toPlainText(fileRecord.relPath) || toPlainText(fileRecord.absPath);
      })
      .filter(Boolean);
    return [directoryPath, ...fileLines.map((file) => `  ${file}`)].filter(Boolean);
  });

  return lines.length > 0 ? lines.join("\n") : t("No output captured.");
}

export function buildCursorToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  if (state.status === "error") return defaultStrategy;

  const toolKey = tool.tool.toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "read" || toolKey === "read_file_v2") {
    const content = extractCursorReadContent(state.outputValue);
    const totalLines = getCursorOutputRecord(state.outputValue).totalLinesInFile;
    const lineCount = typeof totalLines === "number" ? String(totalLines) : toPlainText(totalLines);
    const read = buildFileReadStrategy({
      defaultStrategy,
      state,
      filePath,
      displayPath,
      text: content,
      details: lineCount ? [{ label: t("Lines"), value: lineCount }] : [],
      isCode: content !== t("No output captured."),
    });
    return { ...read, showInputPreview: true };
  }

  if (toolKey === "edit" || toolKey === "edit_file_v2") {
    const diffText = toStringValue(input.streamingContent);
    const edit = buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      outputContent: diffText
        ? { kind: "plain", text: diffText, language: "diff", isCode: true }
        : defaultStrategy.outputContent,
    });
    return {
      ...edit,
      showInputPreview: true,
      contentLabel: diffText ? t("Request") : undefined,
    };
  }

  if (toolKey === "grep" || toolKey === "ripgrep_raw_search") {
    const pattern = toPlainText(input.pattern);
    const path = toPlainText(input.path);
    const summary = [getDisplayPath(path, baseDirectory), pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "grep",
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: true,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "glob" || toolKey === "glob_file_search") {
    const pattern = toPlainText(input.globPattern);
    const targetDirectory = toPlainText(input.targetDirectory);
    const summary = [getDisplayPath(targetDirectory, baseDirectory), pattern]
      .filter(Boolean)
      .join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "glob",
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: true,
      outputContent: {
        kind: "plain",
        text: formatCursorSearchOutput(state.outputValue),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "bash" || toolKey === "run_terminal_command_v2") {
    const command = toPlainText(input.command);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    const description = toPlainText(input.commandDescription);
    const secondaryText = description
      ? `${description}${displayCommand ? ` (${displayCommand})` : ""}`
      : displayCommand
        ? `(${displayCommand})`
        : undefined;
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText,
      details: [],
      showInputPreview: true,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  return { ...defaultStrategy, title: getToolTitle(tool) };
}
