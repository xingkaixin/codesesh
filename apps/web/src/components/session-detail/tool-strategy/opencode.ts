import { t } from "../../../i18n/translate";
import type { ToolPart } from "@codesesh/contract";
import type { QuestionListItem, TaskListItem } from "../../tool-output/types";
import { Bot, CircleHelp, FileSearch, ListTodo } from "../../ui/icons";
import { buildStructuredDiffFromTexts, extractEditDiff } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
  toPlainText,
  toRecord,
  toStringValue,
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

function questionOutput(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const answers = Array.isArray(metadata.answers) ? metadata.answers : [];
  return (Array.isArray(input.questions) ? input.questions : []).flatMap(
    (value, index): QuestionListItem[] => {
      const question = toRecord(value);
      const questionText = toPlainText(question.question);
      if (!questionText) return [];
      const answer = answers[index];
      return [
        {
          header: toPlainText(question.header) || undefined,
          question: questionText,
          options: (Array.isArray(question.options) ? question.options : []).flatMap((value) => {
            const option = toRecord(value);
            const label = toPlainText(option.label);
            return label
              ? [{ label, description: toPlainText(option.description) || undefined }]
              : [];
          }),
          answers: Array.isArray(answer)
            ? answer.filter((value): value is string => typeof value === "string" && !!value.trim())
            : [],
          unansweredLabel: t("No answer recorded"),
        },
      ];
    },
  );
}

function todoOutput(todos: unknown): TaskListItem[] {
  if (!Array.isArray(todos)) return [];
  const items: TaskListItem[] = [];
  for (const value of todos) {
    const todo = toRecord(value);
    const label = toPlainText(todo.content);
    const status = todo.status;
    if (!label || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      return [];
    }
    items.push({ label, status, detail: toPlainText(todo.priority) || undefined });
  }
  return items;
}

export function buildOpencodeToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const toolKey = tool.tool.toLowerCase();
  const input = toRecord(state.inputValue);
  const metadata = toRecord(state.metadataValue);
  if (typeof metadata.exit === "number") {
    defaultStrategy.details.push({ label: t("Exit code"), value: String(metadata.exit) });
  }
  if (metadata.truncated === true) {
    defaultStrategy.details.push({ label: t("Output"), value: t("Truncated") });
  }
  const outputPath = toPlainText(metadata.outputPath);
  if (outputPath) defaultStrategy.details.push({ label: t("Full output"), value: outputPath });
  if (toolKey === "invalid") {
    defaultStrategy.secondaryText = toPlainText(input.tool) || undefined;
    defaultStrategy.showInputPreview = state.status !== "error";
  }
  if (state.status === "error") {
    const error = toPlainText(state.errorValue);
    const output = toPlainText(state.outputValue);
    return error && output
      ? {
          ...defaultStrategy,
          contentLabel: t("Error"),
          outputContent: {
            kind: "plain",
            text: `${error}\n\n${output}`,
            language: "text",
            isCode: false,
          },
        }
      : defaultStrategy;
  }
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "question") {
    const questions = questionOutput(input, metadata);
    if (!questions.length) return defaultStrategy;
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      secondaryText: t("{0}/{1} answered", [
        questions.filter((question) => question.answers.length > 0).length,
        questions.length,
      ]),
      showInputPreview: false,
      contentLabel: t("Questions"),
      outputContent: { kind: "question-list", questions },
    };
  }

  if (toolKey === "todowrite" || toolKey === "todoread") {
    const items = todoOutput(metadata.todos ?? input.todos);
    if (!items.length) return defaultStrategy;
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      secondaryText: undefined,
      showInputPreview: false,
      contentLabel: t("Task state"),
      outputContent: { kind: "task-list", items },
    };
  }

  if (toolKey === "task" || toolKey === "subagent") {
    const prompt = toStringValue(input.prompt);
    const command = toPlainText(input.command);
    const sessionId = toPlainText(metadata.sessionId) || toPlainText(metadata.sessionID);
    return {
      ...defaultStrategy,
      Icon: Bot,
      secondaryText:
        [toPlainText(input.subagent_type), toPlainText(input.description)]
          .filter(Boolean)
          .join(" · ") || undefined,
      details: [
        ...defaultStrategy.details,
        ...(sessionId ? [{ label: t("Session"), value: sessionId }] : []),
        ...(command ? [{ label: t("Command"), value: command }] : []),
        ...(prompt ? [{ label: t("Request"), value: prompt }] : []),
      ],
      showInputPreview: false,
      contentLabel: t("Agent result"),
    };
  }

  if (toolKey === "webfetch") {
    const format = toPlainText(input.format);
    return {
      ...defaultStrategy,
      Icon: FileSearch,
      secondaryText: toPlainText(input.url) || undefined,
      details: [
        ...defaultStrategy.details,
        ...(format ? [{ label: t("Format"), value: format }] : []),
      ],
      showInputPreview: false,
      outputContent: {
        kind: "plain",
        text: getOutputOrErrorText(state),
        language: format === "markdown" ? "markdown" : "text",
        isCode: false,
      },
    };
  }

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

  if (toolKey === "bash" || toolKey === "shell") {
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
    const blocks = buildStructuredDiffFromTexts(
      displayPath || filePath,
      toPlainText(input.oldString),
      toPlainText(input.newString),
    );
    return buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      outputContent: blocks.length
        ? { kind: "structured-diff", blocks }
        : {
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
