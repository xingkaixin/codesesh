/**
 * ZCode tool display strategy — bash/read/edit/write/todo/agent/ask rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { MessagePart } from "../../../lib/api";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type { ToolDetailItem } from "../codex-tool";
import { buildStructuredDiffFromTexts, buildZCodeEditDiffBlocks } from "../diff";
import {
  getDisplayPath,
  getDisplayTextWithRelativePaths,
  getFilePathFromInput,
} from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  normalizeToolName,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { buildDefaultToolStrategy, extractReadContent, extractWriteContent } from "./shared";
import {
  Bot,
  BookOpenText,
  CircleHelp,
  FilePenLine,
  FilePlus2,
  FileSearch,
  ListTodo,
  SquareTerminal,
  Wrench,
} from "lucide-react";

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
