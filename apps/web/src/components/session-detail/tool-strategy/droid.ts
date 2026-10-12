/**
 * Factory Droid tool display strategy — Read/Create/Edit/ApplyPatch/Execute/Grep/Glob/LS/TodoWrite.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import type { TaskListItem } from "../../tool-output/types";
import { buildStructuredDiffFromTexts } from "../diff";
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
} from "./shared";
import { ListTodo } from "../../ui/icons";

export function buildDroidToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  switch (tool.tool) {
    case "Read":
      return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath });
    case "Create":
      return buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath });
    case "Edit": {
      const blocks = buildStructuredDiffFromTexts(
        displayPath || filePath,
        toStringValue(input.old_str),
        toStringValue(input.new_str),
      );
      return buildFileEditStrategy({
        defaultStrategy,
        displayPath,
        outputContent:
          blocks.length > 0 && state.status !== "error"
            ? { kind: "structured-diff", blocks }
            : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
      });
    }
    case "ApplyPatch": {
      const patch = toStringValue(input.input);
      const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
        ([, path = ""]) => getDisplayPath(path.trim(), baseDirectory),
      );
      return buildFileEditStrategy({
        defaultStrategy,
        displayPath: files.join(", "),
        outputContent:
          patch && state.status !== "error"
            ? { kind: "plain", text: patch, language: "diff", isCode: true }
            : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
      });
    }
    case "Execute":
      return buildShellToolStrategy({
        defaultStrategy,
        state,
        title: "bash",
        command: toPlainText(input.command),
        baseDirectory,
      });
    case "Grep":
      return buildSearchToolStrategy({
        defaultStrategy,
        state,
        title: "grep",
        path: toPlainText(input.path),
        pattern: toPlainText(input.pattern),
        baseDirectory,
      });
    case "Glob":
      return buildSearchToolStrategy({
        defaultStrategy,
        state,
        title: "glob",
        path: toPlainText(input.folder),
        pattern: Array.isArray(input.patterns) ? input.patterns.map(toPlainText).join(", ") : "",
        baseDirectory,
      });
    case "LS":
      return buildSearchToolStrategy({
        defaultStrategy,
        state,
        title: "ls",
        path: toPlainText(input.directory_path),
        baseDirectory,
      });
    case "TodoWrite": {
      if (!Array.isArray(input.todos)) return defaultStrategy;
      const items: TaskListItem[] = input.todos.map((value) => {
        const todo = toRecord(value);
        const status = todo.status;
        return {
          label: toStringValue(todo.content) || toStringValue(todo.description),
          status: status === "completed" || status === "in_progress" ? status : "pending",
        };
      });
      return {
        ...defaultStrategy,
        Icon: ListTodo,
        title: "tasks",
        secondaryText: undefined,
        showInputPreview: false,
        outputContent: { kind: "task-list", items },
      };
    }
    default:
      return defaultStrategy;
  }
}
