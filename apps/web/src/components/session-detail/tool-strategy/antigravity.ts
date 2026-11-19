import { createPatch } from "diff";
import type { ToolPart } from "@codesesh/contract";
import { t } from "../../../i18n/translate";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type { FileSectionItem } from "../../tool-output/types";
import { Bot, NotebookPen } from "../../ui/icons";
import { getDisplayPath } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  type ToolStrategyOptions,
  getOutputOrErrorText,
  parseInputCandidate,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import {
  EMPTY_TOOL_OUTPUT,
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildShellToolStrategy,
} from "./shared";

export function buildAntigravityToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
  options?: ToolStrategyOptions,
): ToolDisplayStrategy {
  const includeOutput = options?.includeOutput ?? true;
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory, options);
  const input = toRecord(state.inputValue);
  const filePath =
    toPlainText(input.Path) || toPlainText(input.AbsolutePath) || toPlainText(input.TargetFile);
  const displayPath = getDisplayPath(filePath, baseDirectory);
  const getResultText = () =>
    [...new Set([toStringValue(state.errorValue), toStringValue(state.outputValue)])]
      .filter(Boolean)
      .join("\n\n") || getOutputOrErrorText(state);
  const getResultContent = () =>
    ({
      kind: "plain",
      text: getResultText(),
      language: "text",
      isCode: false,
    }) as const;

  switch (tool.tool) {
    case "read_file":
    case "view_file": {
      const read = buildFileReadStrategy({
        defaultStrategy,
        state,
        filePath,
        displayPath,
        text: getResultText,
        isCode: state.status !== "error",
        includeOutput,
      });
      return {
        ...read,
        showInputPreview: true,
        outputContent: !includeOutput
          ? EMPTY_TOOL_OUTPUT
          : state.status === "error"
            ? getResultContent()
            : read.outputContent,
      };
    }
    case "run_command": {
      const shell = buildShellToolStrategy({
        defaultStrategy,
        state,
        title: tool.tool,
        command: toStringValue(input.CommandLine),
        baseDirectory,
        includeCommandDetail: true,
        includeOutput,
      });
      const cwd = getDisplayPath(toPlainText(input.Cwd), baseDirectory);
      return {
        ...shell,
        details: [...shell.details, ...(cwd ? [{ label: t("Workdir"), value: cwd }] : [])],
        showInputPreview: true,
        outputContent: includeOutput ? getResultContent() : EMPTY_TOOL_OUTPUT,
      };
    }
    case "write_file":
    case "write_to_file":
    case "edit_file":
    case "replace_file_content": {
      const isWrite = tool.tool === "write_file" || tool.tool === "write_to_file";
      const operation = isWrite ? "write" : "edit";
      const edit = buildFileEditStrategy({
        defaultStrategy,
        displayPath,
        includeOutput,
        outputContent: () => {
          const sections: FileSectionItem[] = [
            {
              label: t("Result"),
              operation,
              language: "text",
              isCode: false,
              text: getResultText(),
            },
          ];
          const content = input.Content ?? input.CodeContent;
          const target = input.Target ?? input.TargetContent;
          const replacement = input.Replacement ?? input.ReplacementContent;
          if (isWrite && typeof content === "string") {
            sections.push({
              label: t("Requested content"),
              operation,
              language: detectLanguageByFilePath(filePath),
              isCode: true,
              text: content,
            });
          } else if (!isWrite && typeof target === "string" && typeof replacement === "string") {
            sections.push({
              label: t("Requested changes"),
              operation,
              language: "diff",
              isCode: true,
              text: createPatch(displayPath || filePath, target, replacement),
            });
          }
          return { kind: "file-sections", sections };
        },
      });
      return {
        ...edit,
        ...(isWrite ? { Icon: NotebookPen, title: "write" } : {}),
        showInputPreview: true,
      };
    }
    case "swarm": {
      const outputContent = !includeOutput
        ? EMPTY_TOOL_OUTPUT
        : (() => {
            const body = toStringValue(state.outputValue).replace(
              /^Created At: [^\n]*\nCompleted At: [^\n]*\n/,
              "",
            );
            const result = toRecord(parseInputCandidate(body));
            return state.status !== "error" && Object.keys(result).length > 0
              ? {
                  kind: "property-list" as const,
                  items: Object.entries(result).map(([label, value]) => ({ label, value })),
                }
              : getResultContent();
          })();
      return {
        ...defaultStrategy,
        Icon: Bot,
        title: [tool.tool, toPlainText(input.action)].filter(Boolean).join(" · "),
        secondaryText: toPlainText(input.name) || undefined,
        outputContent,
      };
    }
    default:
      return {
        ...defaultStrategy,
        outputContent: includeOutput ? getResultContent() : EMPTY_TOOL_OUTPUT,
      };
  }
}
