/**
 * Cross-agent tool-strategy infrastructure: the default, skill, and file
 * strategy builders reused by 2+ agent builders.
 *
 * Pure logic — no React. Consumed by the per-agent builders in this folder.
 */
import type { ToolPart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type { ToolOutputContent } from "../../tool-output/types";
import type { ToolDetailItem } from "../codex-tool";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStatus,
  buildSemanticOutputContent,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  joinToolText,
  normalizeEscapedNewlines,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { getDisplayPath, getDisplayTextWithRelativePaths } from "../path-extract";
import {
  BookOpenText,
  FilePenLine,
  FileSearch,
  NotebookPen,
  SquareTerminal,
  Wrench,
} from "../../ui/icons";

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

interface FileStrategyContext {
  defaultStrategy: ToolDisplayStrategy;
  displayPath: string;
}

interface FileToolStrategyOptions extends FileStrategyContext {
  outputContent: ToolOutputContent;
  Icon: ToolDisplayStrategy["Icon"];
  title: "read" | "write" | "edit";
  details?: ToolDetailItem[];
}

interface FileReadStrategyOptions extends FileStrategyContext {
  state: NormalizedToolState;
  filePath: string;
  outputContent?: ToolOutputContent | null;
  text?: string;
  isCode?: boolean;
  details?: ToolDetailItem[];
}

interface FileWriteStrategyOptions extends FileStrategyContext {
  state: NormalizedToolState;
  filePath: string;
  Icon?: ToolDisplayStrategy["Icon"];
  isCode?: boolean;
}

interface FileEditStrategyOptions extends FileStrategyContext {
  outputContent: ToolOutputContent;
  details?: ToolDetailItem[];
}

interface SearchToolStrategyOptions {
  defaultStrategy: ToolDisplayStrategy;
  state: NormalizedToolState;
  title: string;
  path?: string;
  pattern?: string;
  baseDirectory?: string;
}

interface ShellToolStrategyOptions {
  defaultStrategy: ToolDisplayStrategy;
  state: NormalizedToolState;
  title: string;
  command: string;
  description?: string;
  baseDirectory?: string;
  includeCommandDetail?: boolean;
  emptyOutputMarker?: string;
}

function buildFileToolStrategy(options: FileToolStrategyOptions): ToolDisplayStrategy {
  return {
    ...options.defaultStrategy,
    Icon: options.Icon,
    title: options.title,
    secondaryText: options.displayPath || undefined,
    details: options.details ?? options.defaultStrategy.details,
    showInputPreview: false,
    outputContent: options.outputContent,
  };
}

export function buildFileReadStrategy(options: FileReadStrategyOptions): ToolDisplayStrategy {
  return buildFileToolStrategy({
    ...options,
    Icon: BookOpenText,
    title: "read",
    outputContent: options.outputContent ?? {
      kind: "plain",
      text: options.text ?? extractReadContent(options.state.outputValue),
      language: detectLanguageByFilePath(options.filePath),
      isCode: options.isCode ?? true,
    },
  });
}

export function buildFileWriteStrategy(options: FileWriteStrategyOptions): ToolDisplayStrategy {
  return buildFileToolStrategy({
    ...options,
    Icon: options.Icon ?? NotebookPen,
    title: "write",
    outputContent: {
      kind: "plain",
      text: extractWriteContent(options.state),
      language: detectLanguageByFilePath(options.filePath),
      isCode: options.isCode ?? options.state.status === "completed",
    },
  });
}

export function buildFileEditStrategy(options: FileEditStrategyOptions): ToolDisplayStrategy {
  return buildFileToolStrategy({
    ...options,
    Icon: FilePenLine,
    title: "edit",
  });
}

export function buildSearchToolStrategy(options: SearchToolStrategyOptions): ToolDisplayStrategy {
  const secondaryText = [getDisplayPath(options.path ?? "", options.baseDirectory), options.pattern]
    .filter(Boolean)
    .join(" · ");

  return {
    ...options.defaultStrategy,
    Icon: FileSearch,
    title: options.title,
    secondaryText: secondaryText || undefined,
    showInputPreview: false,
    outputContent: {
      kind: "plain",
      text: getOutputOrErrorText(options.state),
      language: "text",
      isCode: false,
    },
  };
}

export function buildShellToolStrategy(options: ShellToolStrategyOptions): ToolDisplayStrategy {
  const displayCommand = getDisplayTextWithRelativePaths(options.command, options.baseDirectory);
  const secondaryText = options.description
    ? `${options.description}${displayCommand ? ` (${displayCommand})` : ""}`
    : displayCommand
      ? `(${displayCommand})`
      : undefined;
  const outputText = getOutputOrErrorText(options.state);

  return {
    ...options.defaultStrategy,
    Icon: SquareTerminal,
    title: options.title,
    secondaryText,
    details:
      options.includeCommandDetail && options.command
        ? [{ label: "Command", value: displayCommand || options.command }]
        : options.defaultStrategy.details,
    showInputPreview: false,
    outputContent: {
      kind: "plain",
      text: options.emptyOutputMarker === outputText ? "No output captured." : outputText,
      language: "text",
      isCode: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool display strategies
// ---------------------------------------------------------------------------

export function buildDefaultToolStrategy(
  tool: ToolPart,
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

  const semanticOutput = buildSemanticOutputContent(state.outputValue);

  return {
    Icon: SquareTerminal,
    title: getToolTitle(tool),
    secondaryText: previewText ? `(${previewText})` : undefined,
    details: [],
    expandable: true,
    showInputPreview: true,
    outputContent:
      semanticOutput ??
      ({
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      } as const),
  };
}

export function buildSkillToolStrategy(
  tool: ToolPart,
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
