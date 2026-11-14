import type { ToolPart } from "@codesesh/contract";
import { t } from "../../../i18n/translate";
import { detectLanguageByFilePath } from "../../tool-output/language";
import type { PlainToolOutputContent } from "../../tool-output/types";
import { NotebookPen, SquareTerminal } from "../../ui/icons";
import { getDisplayPath } from "../path-extract";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  buildSemanticOutputContent,
  normalizeToolName,
  toDisplayText,
  toPlainText,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { buildCodeExecutionStrategy } from "./code-execution";
import {
  buildDefaultToolStrategy,
  buildFileReadStrategy,
  buildSearchToolStrategy,
  buildShellToolStrategy,
} from "./shared";

function textOutput(value: unknown): PlainToolOutputContent {
  return {
    kind: "plain",
    text: typeof value === "string" ? value : toDisplayText(value),
    language: "text",
    isCode: false,
  };
}

export function buildDeepChatToolStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  baseDirectory?: string,
): ToolDisplayStrategy {
  const toolKey = normalizeToolName(tool);
  if (toolKey === "run_code") return buildCodeExecutionStrategy(tool, state, "typescript");

  const defaultStrategy = buildDefaultToolStrategy(tool, state, baseDirectory);
  if (state.status === "error") {
    return {
      ...defaultStrategy,
      outputContent: textOutput(state.errorValue || state.outputValue),
    };
  }

  const input = toRecord(state.inputValue);
  const output = toRecord(state.outputValue);
  const filePath = toPlainText(input.path);
  const displayPath = getDisplayPath(filePath, baseDirectory);

  if (toolKey === "read") {
    return {
      ...buildFileReadStrategy({
        defaultStrategy,
        state,
        filePath,
        displayPath,
        text: toStringValue(state.outputValue),
        details: [
          ...(typeof input.offset === "number"
            ? [{ label: t("Offset"), value: String(input.offset) }]
            : []),
          ...(typeof input.limit === "number"
            ? [{ label: t("Limit"), value: String(input.limit) }]
            : []),
        ],
      }),
      showInputPreview: true,
    };
  }

  if (toolKey === "write" && typeof input.content === "string") {
    return {
      ...defaultStrategy,
      Icon: NotebookPen,
      title: "write",
      secondaryText: displayPath || undefined,
      contentLabel: t("Request"),
      outputContent: {
        kind: "plain",
        text: input.content,
        language: detectLanguageByFilePath(filePath),
        isCode: true,
      },
      rawOutput: state.outputValue,
    };
  }

  if (toolKey === "glob" || toolKey === "grep") {
    const options = toolKey === "glob" ? toRecord(input.options) : input;
    const scope = Array.isArray(options.pathScope)
      ? options.pathScope.map((path) => getDisplayPath(toPlainText(path), baseDirectory)).join(", ")
      : "";
    const strategy = buildSearchToolStrategy({
      defaultStrategy,
      state,
      title: toolKey,
      path: scope,
      pattern: toPlainText(input.query),
      baseDirectory,
    });
    const matches = Array.isArray(state.outputValue)
      ? state.outputValue.map((value) => {
          const match = toRecord(value);
          const path = getDisplayPath(toPlainText(match.path), baseDirectory);
          return toolKey === "grep"
            ? `${path}:${match.lineNumber}: ${toStringValue(match.snippet)}`
            : path;
        })
      : null;
    return {
      ...strategy,
      showInputPreview: true,
      outputContent: textOutput(
        matches ? matches.join("\n") || t("No matches") : state.outputValue,
      ),
      rawOutput: matches ? state.outputValue : undefined,
    };
  }

  if (toolKey === "exec") {
    return {
      ...buildShellToolStrategy({
        defaultStrategy,
        state,
        title: "exec",
        command: toStringValue(input.command),
        description: toPlainText(input.description),
        baseDirectory,
      }),
      details: toPlainText(input.cwd)
        ? [
            {
              label: t("Working directory"),
              value: getDisplayPath(toPlainText(input.cwd), baseDirectory),
            },
          ]
        : [],
      showInputPreview: true,
      outputContent: buildSemanticOutputContent(state.outputValue) ?? textOutput(state.outputValue),
    };
  }

  if (toolKey === "process") {
    return {
      ...defaultStrategy,
      Icon: SquareTerminal,
      secondaryText:
        [toPlainText(input.action), toPlainText(input.sessionId)].filter(Boolean).join(" · ") ||
        undefined,
      details: [
        ...(typeof output.status === "string"
          ? [{ label: t("Status"), value: output.status }]
          : []),
        ...(typeof output.exitCode === "number"
          ? [{ label: t("Exit code"), value: String(output.exitCode) }]
          : []),
        ...(output.timedOut === true ? [{ label: t("Timed out"), value: t("Yes") }] : []),
        ...(output.offloaded === true ? [{ label: t("Offloaded"), value: t("Yes") }] : []),
        ...(typeof output.totalLength === "number"
          ? [{ label: t("Output length"), value: String(output.totalLength) }]
          : []),
        ...(typeof output.outputFilePath === "string"
          ? [
              {
                label: t("Full output"),
                value: getDisplayPath(output.outputFilePath, baseDirectory),
              },
            ]
          : []),
      ],
      outputContent:
        typeof output.output === "string"
          ? textOutput(output.output)
          : defaultStrategy.outputContent,
      rawOutput: typeof output.output === "string" ? state.outputValue : undefined,
    };
  }

  return defaultStrategy;
}
