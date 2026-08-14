/**
 * DSH tool display strategy — bash/read/write/edit/glob/grep rendering.
 *
 * Pure logic — no React. Consumed by ./index's TOOL_STRATEGY_BUILDERS.
 */
import type { ToolPart } from "../../../lib/api";
import { buildDshEditDiffBlocks } from "../diff";
import { getDisplayPath, getFilePathFromInput } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  getOutputOrErrorText,
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

export function buildDshToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const input = toRecord(state.inputValue);
  const filePath = getFilePathFromInput(state.inputValue);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  switch (tool.tool.toLowerCase()) {
    case "bash": {
      const shell = buildShellToolStrategy({
        defaultStrategy,
        state,
        title: "bash",
        command: toPlainText(input.command),
        description: toPlainText(input.description),
        baseDirectory,
      });
      const workdir = toPlainText(input.workdir);
      if (!workdir) return shell;
      return {
        ...shell,
        details: [
          ...shell.details,
          { label: "Workdir", value: getDisplayPath(workdir, baseDirectory) },
        ],
      };
    }

    case "read":
      return buildFileReadStrategy({ defaultStrategy, state, filePath, displayPath });

    case "write":
      return buildFileWriteStrategy({ defaultStrategy, state, filePath, displayPath });

    case "edit": {
      const blocks = buildDshEditDiffBlocks(state, displayPath || filePath);
      return buildFileEditStrategy({
        defaultStrategy,
        displayPath,
        outputContent:
          blocks.length > 0
            ? { kind: "structured-diff", blocks }
            : { kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false },
      });
    }

    case "glob":
    case "grep":
      return buildSearchToolStrategy({
        defaultStrategy,
        state,
        title: tool.tool.toLowerCase(),
        path: toPlainText(input.path),
        pattern: toPlainText(input.pattern),
        baseDirectory,
      });

    // A DSH plugin can register any tool; the default card keeps its input and
    // output visible rather than dropping what this build does not recognize.
    default:
      return defaultStrategy;
  }
}
