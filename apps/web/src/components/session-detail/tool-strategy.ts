/**
 * Legacy tool-strategy shell (CS-19 step 1/2).
 *
 * claudecode/opencode/kimi/codex builders and the shared infrastructure
 * (normalizeToolState, buildDefaultToolStrategy, extractors, etc.) have moved
 * to ./tool-strategy/ — re-exported below for existing consumers. cursor/pi/
 * zcode builders and normalizeMessagesForDisplay/formatMessageTime remain
 * here until step 2 finishes the split.
 *
 * Pure logic — no React. Consumed by SessionDetail's ToolItem / MessageItem.
 */
import type { MessagePart } from "../../lib/api";
import { detectLanguageByFilePath } from "../tool-output/language";
import type { ToolDetailItem } from "./codex-tool";
import {
  buildPiEditDiffBlocks,
  buildStructuredDiffFromTexts,
  buildZCodeEditDiffBlocks,
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
  formatToolOutput,
  getOutputOrErrorText,
  getToolTitle,
  normalizeEscapedNewlines,
  normalizeToolName,
  toPlainText,
  toRecord,
  toStringValue,
} from "./tool-normalize";
import { parseJsonText } from "./utils";
import {
  buildDefaultToolStrategy,
  extractReadContent,
  extractWriteContent,
} from "./tool-strategy/shared";

export type { NormalizedToolState, ToolDisplayStrategy, ToolStatus };
export {
  buildClaudeToolStrategy,
  buildCodexToolStrategy,
  buildDefaultToolStrategy,
  buildKimiToolStrategy,
  buildOpencodeToolStrategy,
  buildSkillToolStrategy,
  extractCodexNodeReplTextOutput,
  extractReadContent,
  extractWriteContent,
  getAssistantDisplayLabel,
  getToolDisplayStrategy,
  normalizeMessagesForDisplay,
  normalizeToolState,
} from "./tool-strategy/index";
import {
  Bot,
  BookOpenText,
  CircleHelp,
  FilePenLine,
  FilePlus2,
  FileSearch,
  Image as ImageIcon,
  ListTodo,
  SquareTerminal,
  Wrench,
} from "lucide-react";

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

function stripRecommendedMarker(value: string) {
  return value.replace(/\s*[(（](?:Recommended|推荐)[)）]\s*$/i, "").trim();
}

function buildZCodeTodoOutput(todos: unknown[]) {
  const counts = new Map<string, number>();
  const lines = todos.map((todo) => {
    const item = toRecord(todo);
    const status = toPlainText(item.status) || "pending";
    const priority = toPlainText(item.priority);
    const content = toPlainText(item.content);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const marker = status === "completed" ? "x" : status === "in_progress" ? "~" : " ";
    const suffix = priority ? ` _${priority}_` : "";
    return `- [${marker}] ${content || "(empty todo)"}${suffix}`;
  });

  return {
    text: lines.join("\n") || "No todos captured.",
    summary: [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · "),
    details: [...counts.entries()].map(([status, count]) => ({
      label: status,
      value: String(count),
    })),
  };
}

function parseZCodeQuestionAnswers(outputText: string) {
  const answers = new Map<string, string[]>();
  const pattern = /"([^"]+)"="([^"]+)"/g;
  for (const match of outputText.matchAll(pattern)) {
    const question = match[1]?.trim();
    const answer = match[2]?.trim();
    if (!question || !answer) continue;
    answers.set(question, [stripRecommendedMarker(answer)]);
  }
  return answers;
}

function buildZCodeAskUserQuestionDisplay(inputValue: unknown, outputText: string) {
  const input = toRecord(inputValue);
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const answersByQuestion = parseZCodeQuestionAnswers(outputText);
  const questions = rawQuestions
    .map((value) => {
      const question = toRecord(value);
      const questionText = toPlainText(question.question);
      if (!questionText) return null;
      const options = Array.isArray(question.options)
        ? question.options
            .map((optionValue) => {
              const option = toRecord(optionValue);
              const rawLabel = toPlainText(option.label);
              const label = stripRecommendedMarker(rawLabel);
              if (!label) return null;
              return {
                label,
                description: toPlainText(option.description) || undefined,
                recommended: label !== rawLabel.trim() || undefined,
              };
            })
            .filter((option): option is NonNullable<typeof option> => option != null)
        : [];

      return {
        header: toPlainText(question.header) || undefined,
        question: questionText,
        options,
        answers: answersByQuestion.get(questionText) ?? [],
      };
    })
    .filter((question): question is NonNullable<typeof question> => question != null);

  if (questions.length === 0) {
    return {
      secondaryText: undefined,
      outputContent: { kind: "plain" as const, text: outputText, language: "text", isCode: false },
    };
  }

  return {
    secondaryText: `${questions.length} question${questions.length === 1 ? "" : "s"}`,
    outputContent: { kind: "question-list" as const, questions },
  };
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

// ---------------------------------------------------------------------------
// Tool display strategies
// ---------------------------------------------------------------------------

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

export function buildZCodeToolStrategy(
  tool: MessagePart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = normalizeToolName(tool);
  const input = toRecord(state.inputValue);
  const metadata = toRecord(state.metadataValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);
  const outputText = getOutputOrErrorText(state);

  if (toolKey === "bash") {
    const description = toPlainText(input.description);
    const command = toPlainText(input.command);
    const displayCommand = getDisplayTextWithRelativePaths(command, baseDirectory);
    const cleanedOutput =
      outputText === "(Bash completed with no output)" ? "No output captured." : outputText;
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      title: "bash",
      secondaryText: description
        ? `${description}${displayCommand ? ` (${displayCommand})` : ""}`
        : displayCommand
          ? `(${displayCommand})`
          : undefined,
      details: command ? [{ label: "Command", value: displayCommand || command }] : [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: cleanedOutput,
        language: "text",
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

  if (toolKey === "edit") {
    const diffBlocks = buildZCodeEditDiffBlocks(state, displayPath || filePath);
    const oldValue = toStringValue(input.old_string);
    const newValue = toStringValue(input.new_string);
    const fallbackDiffBlocks = buildStructuredDiffFromTexts(
      displayPath || filePath,
      oldValue,
      newValue,
    );
    const blocks = diffBlocks.length > 0 ? diffBlocks : fallbackDiffBlocks;
    const display = toRecord(metadata.display);
    return {
      ...defaultStrategy,
      Icon: FilePenLine,
      title: "edit",
      secondaryText: displayPath || undefined,
      details: [
        typeof display.additions === "number"
          ? { label: "Additions", value: String(display.additions) }
          : null,
        typeof display.deletions === "number"
          ? { label: "Deletions", value: String(display.deletions) }
          : null,
      ].filter((item): item is ToolDetailItem => item != null),
      showInputPreview: false,
      outputContent:
        blocks.length > 0
          ? { kind: "structured-diff", blocks }
          : { kind: "plain", text: outputText, language: "text", isCode: false },
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

  if (toolKey === "glob" || toolKey === "grep") {
    const path = toPlainText(input.path);
    const pattern = toPlainText(input.pattern);
    const secondaryText = [getDisplayPath(path, baseDirectory), pattern]
      .filter(Boolean)
      .join(" · ");
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: toolKey,
      secondaryText: secondaryText || undefined,
      showInputPreview: false,
      outputContent: { kind: "plain", text: outputText, language: "text", isCode: false },
    };
  }

  if (toolKey === "todowrite") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const todoOutput = buildZCodeTodoOutput(todos);
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: "todo",
      secondaryText: todoOutput.summary || undefined,
      details: todoOutput.details,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: todoOutput.text,
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "agent") {
    const subagentType = toPlainText(input.subagent_type);
    const description = toPlainText(input.description);
    return {
      ...defaultStrategy,
      Icon: Bot,
      title: subagentType ? `agent · ${subagentType}` : "agent",
      secondaryText: description || undefined,
      details: subagentType ? [{ label: "Type", value: subagentType }] : [],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: outputText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "askuserquestion") {
    const display = buildZCodeAskUserQuestionDisplay(state.inputValue, outputText);
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      title: "ask",
      secondaryText: display.secondaryText,
      details: [],
      showInputPreview: false,
      outputContent: display.outputContent,
    };
  }

  if (toolKey === "enterplanmode" || toolKey === "exitplanmode") {
    const plan = toStringValue(input.plan);
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      title: toolKey === "enterplanmode" ? "plan mode" : "plan approved",
      secondaryText:
        plan
          .split("\n")
          .find((line) => line.trim())
          ?.replace(/^#+\s*/, "") || undefined,
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: plan || outputText,
        language: "markdown",
        isCode: false,
      },
    };
  }

  if (toolKey === "websearch") {
    const query = toPlainText(input.query);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      title: "web search",
      secondaryText: query || undefined,
      showInputPreview: false,
      outputContent: { kind: "plain", text: outputText, language: "markdown", isCode: false },
    };
  }

  if (toolKey === "skill") {
    const skill = toPlainText(input.skill);
    return {
      ...defaultStrategy,
      Icon: Wrench,
      title: "skill",
      secondaryText: skill || undefined,
      showInputPreview: false,
      outputContent: { kind: "plain", text: outputText, language: "markdown", isCode: false },
    };
  }

  return defaultStrategy;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

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
