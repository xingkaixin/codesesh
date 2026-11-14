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
  getOutputOrErrorText,
  parseInputCandidate,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import {
  buildDefaultToolStrategy,
  buildFileEditStrategy,
  buildFileReadStrategy,
  buildShellToolStrategy,
} from "./shared";

export function buildAntigravityToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  const input = toRecord(state.inputValue);
  const filePath =
    toPlainText(input.Path) || toPlainText(input.AbsolutePath) || toPlainText(input.TargetFile);
  const displayPath = getDisplayPath(filePath, baseDirectory);
  const resultText =
    [...new Set([toStringValue(state.errorValue), toStringValue(state.outputValue)])]
      .filter(Boolean)
      .join("\n\n") || getOutputOrErrorText(state);
  const resultContent = {
    kind: "plain",
    text: resultText,
    language: "text",
    isCode: false,
  } as const;

  switch (tool.tool) {
    case "read_file":
    case "view_file": {
      const read = buildFileReadStrategy({
        defaultStrategy,
        state,
        filePath,
        displayPath,
        text: resultText,
        isCode: state.status !== "error",
      });
      return {
        ...read,
        showInputPreview: true,
        outputContent: state.status === "error" ? resultContent : read.outputContent,
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
      });
      const cwd = getDisplayPath(toPlainText(input.Cwd), baseDirectory);
      return {
        ...shell,
        details: [...shell.details, ...(cwd ? [{ label: t("Workdir"), value: cwd }] : [])],
        showInputPreview: true,
        outputContent: resultContent,
      };
    }
    case "write_file":
    case "write_to_file":
    case "edit_file":
    case "replace_file_content": {
      const isWrite = tool.tool === "write_file" || tool.tool === "write_to_file";
      const operation = isWrite ? "write" : "edit";
      const sections: FileSectionItem[] = [
        { label: t("Result"), operation, language: "text", isCode: false, text: resultText },
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
      const edit = buildFileEditStrategy({
        defaultStrategy,
        displayPath,
        outputContent: { kind: "file-sections", sections },
      });
      return {
        ...edit,
        ...(isWrite ? { Icon: NotebookPen, title: "write" } : {}),
        showInputPreview: true,
      };
    }
    case "swarm": {
      const body = toStringValue(state.outputValue).replace(
        /^Created At: [^\n]*\nCompleted At: [^\n]*\n/,
        "",
      );
      const result = toRecord(parseInputCandidate(body));
      return {
        ...defaultStrategy,
        Icon: Bot,
        title: [tool.tool, toPlainText(input.action)].filter(Boolean).join(" · "),
        secondaryText: toPlainText(input.name) || undefined,
        outputContent:
          state.status !== "error" && Object.keys(result).length > 0
            ? {
                kind: "property-list",
                items: Object.entries(result).map(([label, value]) => ({ label, value })),
              }
            : resultContent,
      };
    }
    default:
      return { ...defaultStrategy, outputContent: resultContent };
  }
}
