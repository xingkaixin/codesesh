/**
 * Kimi-Code tool display strategy.
 *
 * Translate Kimi-Code's source-specific fields before reusing ZCode views.
 * Keep the original input text available for previews.
 */
import type { ToolPart } from "@codesesh/contract";
import { getKimiEditEntries } from "../diff";
import { type NormalizedToolState, type ToolDisplayStrategy, toRecord } from "../tool-normalize";
import { buildKimiToolStrategy } from "./kimi";
import { buildZCodeToolStrategy } from "./zcode";

export function buildKimiCodeToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const toolKey = tool.tool.toLowerCase();
  if (
    ["read", "readfile", "agent", "searchweb"].includes(toolKey) ||
    (toolKey === "strreplacefile" &&
      state.status === "completed" &&
      getKimiEditEntries(state.inputValue).length > 0)
  ) {
    return buildKimiToolStrategy(tool, state, baseDirectory);
  }

  const input = toRecord(state.inputValue);
  let normalizedInput = state.inputValue;
  if (toolKey === "todolist" && Array.isArray(input.todos)) {
    normalizedInput = {
      ...input,
      todos: input.todos.map((todo) => {
        const item = toRecord(todo);
        return item.status === "done" ? { ...item, status: "completed" } : todo;
      }),
    };
  }

  return buildZCodeToolStrategy(
    { ...tool, title: "" },
    { ...state, inputValue: normalizedInput },
    baseDirectory,
  );
}
