import { t } from "../../../i18n/translate";
import type { ToolPart } from "@codesesh/contract";
import type { QuestionListItem, TaskListItem } from "../../tool-output/types";
import { Bot, CircleHelp, ListTodo } from "../../ui/icons";
import { buildStructuredDiffFromTexts } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  getOutputOrErrorText,
  toRecord,
  toStringValue,
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStrategyOptions,
} from "../tool-normalize";
import {
  EMPTY_TOOL_OUTPUT,
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildFileWriteStrategy,
  buildSearchToolStrategy,
  buildShellToolStrategy,
  buildSkillToolStrategy,
} from "./shared";

function questionsFromSteps(steps: unknown[]): QuestionListItem[] {
  return steps.flatMap((value) => {
    const step = toRecord(value);
    const question = toStringValue(step.question);
    if (!question) return [];
    return [
      {
        header: toStringValue(step.header) || undefined,
        question,
        options: (Array.isArray(step.options) ? step.options : []).map((value) => {
          const option = toRecord(value);
          return {
            label: toStringValue(option.label),
            description: toStringValue(option.description) || undefined,
            recommended: option.recommended === true || undefined,
          };
        }),
        answers: [],
      },
    ];
  });
}

export function buildMiniMaxCodeToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
  options?: ToolStrategyOptions,
): ToolDisplayStrategy {
  const includeOutput = options?.includeOutput ?? true;
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory, options);
  if (state.status === "error") return defaultStrategy;
  const key = tool.tool.toLowerCase();
  const input = toRecord(state.inputValue);
  const metadata = toRecord(state.metadataValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (key === "read")
    return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath, includeOutput });
  if (key === "write")
    return buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath, includeOutput });
  if (key === "edit") {
    return buildFileEditStrategy({
      defaultStrategy,
      displayPath,
      includeOutput,
      outputContent: () => {
        const edits = Array.isArray(input.edits)
          ? input.edits
          : [{ oldText: input.old_string, newText: input.new_string }];
        const blocks = edits.flatMap((value) => {
          const edit = toRecord(value);
          return buildStructuredDiffFromTexts(
            displayPath || filePath,
            toStringValue(edit.oldText),
            toStringValue(edit.newText),
          );
        });
        return blocks.length ? { kind: "structured-diff", blocks } : defaultStrategy.outputContent;
      },
    });
  }
  if (key === "bash") {
    const strategy = buildShellToolStrategy({
      defaultStrategy,
      state,
      title: tool.tool,
      command: toStringValue(input.command),
      baseDirectory,
      includeOutput,
    });
    const taskId = toStringValue(metadata.task_id);
    if (taskId) strategy.details.push({ label: "Task ID", value: taskId });
    return strategy;
  }
  if (key === "grep" || key === "glob") {
    return buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: tool.tool,
      path: toStringValue(input.path),
      pattern: toStringValue(input.pattern),
      baseDirectory,
      includeOutput,
    });
  }
  if (key === "skill") return buildSkillToolStrategy(tool, state, defaultStrategy, baseDirectory);
  if (key === "todowrite" && Array.isArray(input.todos)) {
    const items: TaskListItem[] = input.todos.map((value) => {
      const todo = toRecord(value);
      const status = todo.status;
      return {
        label: toStringValue(todo.content),
        status: status === "completed" || status === "in_progress" ? status : "pending",
        detail:
          status === "cancelled"
            ? toStringValue(status)
            : toStringValue(todo.priority) || undefined,
      };
    });
    return {
      ...defaultStrategy,
      Icon: ListTodo,
      showInputPreview: false,
      outputContent: { kind: "task-list", items },
    };
  }
  if (key === "ask_user" && Array.isArray(input.steps) && metadata.suppressed !== true) {
    const questions = questionsFromSteps(input.steps);
    if (!questions.length) return defaultStrategy;
    return {
      ...defaultStrategy,
      Icon: CircleHelp,
      secondaryText: toStringValue(input.title) || undefined,
      details: includeOutput ? [{ label: t("Result"), value: getOutputOrErrorText(state) }] : [],
      showInputPreview: false,
      outputContent: includeOutput ? { kind: "question-list", questions } : EMPTY_TOOL_OUTPUT,
    };
  }
  if (key === "task" || key.startsWith("task_")) {
    const taskId = toStringValue(metadata.task_id) || toStringValue(input.task_id);
    const sessionId = toStringValue(metadata.sub_session_id) || toStringValue(metadata.session_id);
    return {
      ...defaultStrategy,
      Icon: Bot,
      secondaryText:
        toStringValue(input.description) || toStringValue(input.agent_name) || taskId || undefined,
      details: [
        ...(taskId ? [{ label: "Task ID", value: taskId }] : []),
        ...(sessionId ? [{ label: "Session ID", value: sessionId }] : []),
      ],
    };
  }
  if (key === "mcp_invoke") {
    return {
      ...defaultStrategy,
      title: toStringValue(input.tool_name) || tool.tool,
      secondaryText: toStringValue(input.tool_ref) || "mcp_invoke",
    };
  }
  return defaultStrategy;
}
