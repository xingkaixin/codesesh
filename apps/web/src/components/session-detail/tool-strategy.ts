/**
 * Tool display strategies — per-agent builders that turn a NormalizedToolState
 * into a ToolDisplayStrategy (icon, title, details, output content with diff).
 *
 * Also owns the content extractors (read/write/search), subagent helpers,
 * normalizeToolState, normalizeMessagesForDisplay, and the format helpers
 * (formatTokens, formatMessageTime) that the message list consumes.
 *
 * Pure logic — no React. Consumed by SessionDetail's ToolItem / MessageItem.
 */
import type { Message, MessagePart } from "../../lib/api";
import { detectLanguageByFilePath } from "../tool-output/language";
import type { ToolDetailItem } from "./codex-tool";
import {
  buildCodexExecCommandDisplay,
  buildCodexRequestUserInputDisplay,
  buildCodexWriteStdinDisplay,
} from "./codex-tool";
import {
  buildCodexPatchOutputContent,
  getCodexPatchEntries,
  summarizeCodexPatchEntries,
} from "./codex-patch";
import {
  buildKimiEditDiffBlocks,
  buildPiEditDiffBlocks,
  buildStructuredDiffFromTexts,
  extractEditDiff,
} from "./diff";
import {
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "./path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStatus,
  compactText,
  extractCommand,
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  joinToolText,
  normalizeEscapedNewlines,
  normalizeToolName,
  parseInputCandidate,
  toDisplayText,
  toPlainText,
  toRecord,
  toStringValue,
} from "./tool-normalize";
import { parseJsonText } from "./utils";

export type { NormalizedToolState, ToolDisplayStrategy, ToolStatus };
import {
  Bot,
  BookOpenText,
  CircleHelp,
  FilePenLine,
  FilePlus2,
  FileSearch,
  Image as ImageIcon,
  ListTodo,
  NotebookPen,
  SquareTerminal,
  Wrench,
} from "lucide-react";

export function extractCodexNodeReplTextOutput(outputText: string) {
  const marker = "Output:\n";
  const markerIndex = outputText.indexOf(marker);
  if (markerIndex === -1) return outputText;

  const rawOutput = outputText.slice(markerIndex + marker.length).trim();
  const parsed = parseJsonText<unknown>(rawOutput);
  if (!Array.isArray(parsed)) return outputText;

  const text = parsed
    .map((item) => toPlainText(toRecord(item).text))
    .filter(Boolean)
    .join("\n");
  return text || outputText;
}

export function getCursorOutputRecord(rawOutput: unknown) {
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    return rawOutput as Record<string, unknown>;
  }
  if (typeof rawOutput === "string") {
    return parseJsonText<Record<string, unknown>>(rawOutput) || {};
  }
  return {};
}

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

export function extractCursorReadContent(rawOutput: unknown) {
  const output = getCursorOutputRecord(rawOutput);
  const contents = toStringValue(output.contents);
  if (contents) return normalizeEscapedNewlines(contents);
  return "No output captured.";
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

  return lines.length > 0 ? lines.join("\n") : "No output captured.";
}

export function getPiTodoTaskFromDetails(state: NormalizedToolState) {
  const input = toRecord(state.inputValue);
  const details = toRecord(state.metadataValue);
  const rawTasks = Array.isArray(details.tasks) ? details.tasks : [];
  const inputId = Number(input.id);
  const target =
    Number.isFinite(inputId) && inputId > 0
      ? rawTasks.find((task) => Number(toRecord(task).id) === inputId)
      : rawTasks.at(-1);
  return toRecord(target);
}

export function getPiTodoStatusChange(state: NormalizedToolState) {
  const text = getOutputOrErrorText(state);
  const match = text.match(/\(([^()]+?)\s*→\s*([^()]+?)\)/);
  if (!match) return "";
  return `${match[1]} -> ${match[2]}`;
}

export function buildPiSubagentResultDetails(text: string): ToolDetailItem[] {
  const firstLine = text.split("\n")[0] ?? "";
  const agentMatch = firstLine.match(/^Agent:\s*(.+)$/i);
  const summaryLine = text.split("\n").find((line) => line.includes("Status:"));
  const details: ToolDetailItem[] = [];
  if (agentMatch?.[1]) details.push({ label: "Agent", value: agentMatch[1].trim() });
  if (summaryLine) details.push({ label: "Summary", value: summaryLine.trim() });
  return details;
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
// Subagent helpers
// ---------------------------------------------------------------------------

export function getSubagentToolTitle(part: MessagePart) {
  const state = toRecord(part.state);
  const argumentsValue = toRecord(state.arguments);
  const agentType = compactText(argumentsValue.agent_type);
  const nickname = compactText((part as { nickname?: unknown }).nickname);
  const model = compactText(argumentsValue.model);
  const reasoningEffort = compactText(argumentsValue.reasoning_effort);
  const modelSuffix = [model, reasoningEffort].filter(Boolean).join("-");
  const left = [agentType, nickname].filter(Boolean).join(" - ");
  return [left, modelSuffix].filter(Boolean).join(" ");
}

export function getSubagentPrompt(part: MessagePart) {
  const state = toRecord(part.state);
  const prompt = compactText(state.prompt);
  if (prompt) return prompt;

  const argumentsValue = toRecord(state.arguments);
  const message = compactText(argumentsValue.message);
  if (message) return message;

  return "";
}

export function getAssistantDisplayLabel(msg: Message) {
  const nickname = compactText(msg.nickname);
  if (msg.role === "assistant" && nickname) return `AGENT (${nickname})`;
  if (msg.role === "user") return "USER";
  if (msg.role === "tool") return "TOOL";
  return "AGENT";
}

export function normalizeMessagesForDisplay(messages: Message[], sessionAgentKey: string) {
  if (sessionAgentKey.toLowerCase() !== "cursor") return messages;

  const normalized: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool") {
      normalized.push({ ...msg, parts: [...msg.parts] });
      continue;
    }
    const previous = normalized.at(-1);
    if (previous?.role === "assistant") {
      previous.parts.push(...msg.parts);
      continue;
    }
    normalized.push({ ...msg, parts: [...msg.parts] });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Tool state normalization
// ---------------------------------------------------------------------------

export function normalizeToolState(part: MessagePart): NormalizedToolState {
  const rawState = (part.state || {}) as Record<string, unknown>;
  const rawStatus = rawState.status;
  const status: ToolStatus =
    rawStatus === "running" || rawStatus === "error" || rawStatus === "completed"
      ? rawStatus
      : "completed";

  const outputValue = rawState.output ?? rawState.result ?? "";
  const errorValue = rawState.error ?? "";
  const inputValue = parseInputCandidate(rawState.input ?? rawState.arguments ?? {});
  const metadataValue = rawState.metadata ?? {};
  const command = extractCommand(inputValue);

  return {
    status,
    command,
    inputValue,
    outputValue,
    errorValue,
    metadataValue,
    inputText: toDisplayText(inputValue),
  };
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

export function buildOpencodeToolStrategy(
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
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: tool.tool || "read",
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
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: tool.tool || "edit",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractEditDiff(state),
        language: "diff",
        isCode: true,
      },
    };
  }

  if (toolKey === "write") {
    const filePath = getFilePathFromInput(state.inputValue);
    const displayPath = getDisplayPath(filePath, baseDirectory);
    const isSuccessfulWrite = state.status === "completed";
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: tool.tool || "write",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractWriteContent(state),
        language: detectLanguageByFilePath(filePath),
        isCode: isSuccessfulWrite,
      },
    };
  }

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy, baseDirectory);
  }

  return defaultStrategy;
}

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

export function buildCodexToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = normalizeToolName(tool);
  const metadata = toRecord(state.metadataValue);
  const namespace = toPlainText(metadata.namespace);
  const formatPathForDisplay = (path: string) => getDisplayPath(path, baseDirectory);
  const formatTextForDisplay = (text: string) =>
    getDisplayTextWithRelativePaths(text, baseDirectory);

  if (toolKey === "skill") {
    return buildSkillToolStrategy(tool, state, defaultStrategy, baseDirectory);
  }

  if (
    toolKey === "js" &&
    (namespace === "mcp__node_repl__" || namespace === "mcp__node_repl__.js")
  ) {
    const input = toRecord(state.inputValue);
    const title = toPlainText(input.title);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "Browser",
      secondaryText: title || undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: extractCodexNodeReplTextOutput(getOutputOrErrorText(state)),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "exec_command" || toolKey === "bash") {
    const display = buildCodexExecCommandDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
      formatPathForDisplay,
      formatTextForDisplay,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "write_stdin") {
    const display = buildCodexWriteStdinDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
      detectLanguageByFilePath,
    );
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: display.outputAnalysis.text,
        language: display.outputAnalysis.language,
        isCode: display.outputAnalysis.isCode,
      },
    };
  }

  if (toolKey === "request_user_input") {
    const display = buildCodexRequestUserInputDisplay(
      state.inputValue,
      getOutputOrErrorText(state),
    );
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      title: "ask",
      secondaryText: display.secondaryText,
      details: display.details,
      showInputPreview: false,
      outputContent: display.outputContent,
    };
  }

  if (toolKey === "patch") {
    const entries = getCodexPatchEntries(state.inputValue);
    const summary = summarizeCodexPatchEntries(entries);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: getToolTitle(tool, "patch"),
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: buildCodexPatchOutputContent(
        entries,
        getOutputOrErrorText(state),
        detectLanguageByFilePath,
        formatPathForDisplay,
      ),
    };
  }

  if (toolKey === "subagent") {
    const prompt = getSubagentPrompt(tool);
    const fallbackText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: getSubagentToolTitle(tool) || getToolTitle(tool, "subagent"),
      secondaryText: undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: prompt || fallbackText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  return defaultStrategy;
}

export function buildCursorToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "read_file_v2") {
    const content = extractCursorReadContent(state.outputValue);
    return {
      ...defaultStrategy,
      Icon: BookOpenText,
      title: "read",
      secondaryText: displayPath || undefined,
      details:
        content === "No output captured."
          ? [
              {
                label: "Lines",
                value: toPlainText(getCursorOutputRecord(state.outputValue).totalLinesInFile),
              },
            ]
          : [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: content,
        language: detectLanguageByFilePath(filePath),
        isCode: content !== "No output captured.",
      },
    };
  }

  if (toolKey === "edit_file_v2") {
    const diffText = normalizeEscapedNewlines(toStringValue(input.streamingContent));
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: displayPath || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: diffText || getOutputOrErrorText(state),
        language: diffText ? "diff" : "text",
        isCode: Boolean(diffText),
      },
    };
  }

  if (toolKey === "ripgrep_raw_search") {
    const pattern = toPlainText(input.pattern);
    const path = toPlainText(input.path);
    const summary = [getDisplayPath(path, baseDirectory), pattern].filter(Boolean).join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "grep",
      secondaryText: summary || undefined,
      details: [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "glob_file_search") {
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
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: formatCursorSearchOutput(state.outputValue),
        language: "text",
        isCode: false,
      },
    };
  }

  if (toolKey === "run_terminal_command_v2") {
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
      showInputPreview: false,
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

export function buildPiToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = (tool.tool || "").toLowerCase();
  const input = toRecord(state.inputValue);
  const metadata = toRecord(state.metadataValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "todo") {
    const action = toPlainText(input.action) || toPlainText(metadata.action) || "todo";
    const task = getPiTodoTaskFromDetails(state);
    const taskId = Number(task.id) || Number(input.id);
    const subject = toPlainText(task.subject) || toPlainText(input.subject);
    const description = toPlainText(task.description) || toPlainText(input.description);
    const status = toPlainText(task.status) || toPlainText(input.status);
    const statusChange = getPiTodoStatusChange(state);
    const secondaryParts = [
      taskId ? `#${taskId}` : "",
      subject,
      action === "update" && statusChange ? statusChange : status,
    ].filter(Boolean);

    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: action === "create" ? "todo create" : action === "update" ? "todo update" : "todo",
      secondaryText: secondaryParts.join(" · ") || undefined,
      details: [
        taskId ? { label: "ID", value: `#${taskId}` } : null,
        subject ? { label: "Subject", value: subject } : null,
        status ? { label: "Status", value: status } : null,
        statusChange ? { label: "Change", value: statusChange } : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: description || getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

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

  if (toolKey === "write") {
    return {
      ...defaultStrategy,
      Icon: FilePlus2,
      title: "write",
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

  if (toolKey === "edit") {
    const diffBlocks = buildPiEditDiffBlocks(state, displayPath || filePath);
    const firstChangedLine =
      typeof metadata.firstChangedLine === "number"
        ? String(metadata.firstChangedLine)
        : toStringValue(metadata.firstChangedLine);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: displayPath || undefined,
      details: firstChangedLine ? [{ label: "Line", value: firstChangedLine }] : [],
      showInputPreview: false,
      outputContent:
        diffBlocks.length > 0
          ? { kind: "structured-diff", blocks: diffBlocks }
          : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
    };
  }

  if (toolKey === "agent") {
    const description = toPlainText(input.description) || toPlainText(metadata.description);
    const subagentType = toPlainText(input.subagent_type) || toPlainText(metadata.subagentType);
    const agentId = toPlainText(metadata.agentId);
    const status = toPlainText(metadata.status);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: subagentType ? `agent · ${subagentType}` : "agent",
      secondaryText: [agentId ? `#${agentId}` : "", description].filter(Boolean).join(" · "),
      details: [
        agentId ? { label: "Agent", value: agentId } : null,
        subagentType ? { label: "Type", value: subagentType } : null,
        status ? { label: "Status", value: status } : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: toStringValue(input.prompt) || getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "get_subagent_result") {
    const agentId = toPlainText(input.agent_id);
    const outputText = getOutputOrErrorText(state);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: "subagent result",
      secondaryText: agentId ? `#${agentId}` : undefined,
      details: buildPiSubagentResultDetails(outputText),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: outputText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "analyze_image") {
    const images = Array.isArray(input.images)
      ? input.images.map((image) => toStringValue(image)).filter(Boolean)
      : [];
    const question = toStringValue(input.question);
    return {
      ...defaultStrategy,
      Icon: ImageIcon,
      title: "analyze image",
      secondaryText: images.map((image) => getDisplayPath(image, baseDirectory)).join(", "),
      details: [
        ...images.map((image, index) => ({
          label: index === 0 ? "Image" : `Image ${index + 1}`,
          value: getDisplayPath(image, baseDirectory),
        })),
        question ? { label: "Question", value: question } : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "bash" || toolKey === "batch") {
    const command = toPlainText(input.command);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: toolKey === "batch" ? "batch" : "bash",
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

  return defaultStrategy;
}

export function getToolDisplayStrategy(
  sessionAgentKey: string,
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const normalizedAgentKey = sessionAgentKey.toLowerCase();
  if (normalizedAgentKey === "opencode")
    return buildOpencodeToolStrategy(tool, state, baseDirectory);
  if (normalizedAgentKey === "codex") return buildCodexToolStrategy(tool, state, baseDirectory);
  if (normalizedAgentKey === "kimi") return buildKimiToolStrategy(tool, state, baseDirectory);
  if (normalizedAgentKey === "claudecode") {
    return buildClaudeToolStrategy(tool, state, baseDirectory);
  }
  if (normalizedAgentKey === "cursor") return buildCursorToolStrategy(tool, state, baseDirectory);
  if (normalizedAgentKey === "pi") return buildPiToolStrategy(tool, state, baseDirectory);
  return buildDefaultToolStrategy(tool, state, baseDirectory);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatMessageTime(rawTime: number | string) {
  if (typeof rawTime === "number" && rawTime <= 0) return "Unknown time";

  let date: Date | null = null;
  if (typeof rawTime === "number") {
    const normalized = rawTime < 10 ** 12 ? rawTime * 1000 : rawTime;
    date = new Date(normalized);
  } else if (typeof rawTime === "string") {
    if (rawTime.trim()) {
      const timestamp = Number(rawTime);
      if (!Number.isNaN(timestamp) && timestamp > 0) {
        date = new Date(timestamp < 10 ** 12 ? timestamp * 1000 : timestamp);
      } else {
        date = new Date(rawTime);
      }
    }
  }

  if (!date || Number.isNaN(date.getTime())) return "Unknown time";

  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}
